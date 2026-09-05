'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const Stripe = require('stripe');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

/*
|--------------------------------------------------------------------------
| Environment configuration
|--------------------------------------------------------------------------
*/

const requiredEnvironmentVariables = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'REFERRAL_PANEL_CHANNEL_ID',
  'REFERRAL_ENTRY_CHANNEL_ID',
  'STRIPE_SECRET_KEY',
];

for (const variableName of requiredEnvironmentVariables) {
  const value = process.env[variableName];

  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable: ${variableName}`,
    );
  }
}

function readNonNegativeInteger(name, defaultValue) {
  const rawValue = process.env[name] || String(defaultValue);
  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(
      `${name} must be a non-negative whole number.`,
    );
  }

  return parsedValue;
}

const config = {
  token: process.env.DISCORD_TOKEN.trim(),
  clientId: process.env.CLIENT_ID.trim(),
  guildId: process.env.GUILD_ID.trim(),

  panelChannelId:
    process.env.REFERRAL_PANEL_CHANNEL_ID.trim(),

  entryChannelId:
    process.env.REFERRAL_ENTRY_CHANNEL_ID.trim(),
  stripeSecretKey:
    process.env.STRIPE_SECRET_KEY.trim(),

  verifiedRoleId:
    process.env.REFERRAL_VERIFIED_ROLE_ID?.trim() || null,

  pointsPerReferral: readNonNegativeInteger(
    'REFERRAL_POINTS_PER_INVITE',
    100,
  ),

  qualificationHours: readNonNegativeInteger(
    'REFERRAL_QUALIFICATION_HOURS',
    24,
  ),

  leaderboardLimit: readNonNegativeInteger(
    'REFERRAL_LEADERBOARD_LIMIT',
    10,
  ),
};

const stripe = new Stripe(config.stripeSecretKey);

/*
|--------------------------------------------------------------------------
| SQLite database
|--------------------------------------------------------------------------
*/

const dataDirectory = path.join(__dirname, 'data');

fs.mkdirSync(dataDirectory, {
  recursive: true,
});

const databasePath = path.join(
  dataDirectory,
  'referrals.sqlite',
);

const database = new Database(databasePath);

database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');

database.exec(`
  CREATE TABLE IF NOT EXISTS referral_invites (
    invite_code TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    last_known_uses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_one_active_referral_invite_per_member
  ON referral_invites (
    guild_id,
    owner_user_id
  )
  WHERE is_active = 1;

  CREATE TABLE IF NOT EXISTS referral_attributions (
    guild_id TEXT NOT NULL,
    referred_user_id TEXT NOT NULL,
    inviter_user_id TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    qualified_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    PRIMARY KEY (
      guild_id,
      referred_user_id
    )
  );

  CREATE INDEX IF NOT EXISTS
    idx_referral_attributions_inviter
  ON referral_attributions (
    guild_id,
    inviter_user_id,
    status
  );

  CREATE TABLE IF NOT EXISTS referral_point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    referred_user_id TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    points INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,

    UNIQUE (
      guild_id,
      referred_user_id,
      transaction_type
    )
  );

  CREATE INDEX IF NOT EXISTS
    idx_referral_points_user
  ON referral_point_transactions (
    guild_id,
    user_id
  );

  CREATE TABLE IF NOT EXISTS creator_stripe_accounts (
    discord_user_id TEXT PRIMARY KEY,
    stripe_account_id TEXT UNIQUE NOT NULL,
    onboarding_status TEXT NOT NULL DEFAULT 'pending',
    charges_enabled INTEGER NOT NULL DEFAULT 0,
    payouts_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/*
|--------------------------------------------------------------------------
| Prepared database statements
|--------------------------------------------------------------------------
*/

const statements = {
  getActiveInviteForUser: database.prepare(`
    SELECT
      invite_code,
      channel_id,
      last_known_uses
    FROM referral_invites
    WHERE guild_id = ?
      AND owner_user_id = ?
      AND is_active = 1
    LIMIT 1
  `),

  getInviteOwner: database.prepare(`
    SELECT owner_user_id
    FROM referral_invites
    WHERE guild_id = ?
      AND invite_code = ?
      AND is_active = 1
    LIMIT 1
  `),

  saveInvite: database.prepare(`
    INSERT INTO referral_invites (
      invite_code,
      guild_id,
      channel_id,
      owner_user_id,
      last_known_uses,
      created_at,
      is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `),

  deactivateInvite: database.prepare(`
    UPDATE referral_invites
    SET
      is_active = 0,
      deleted_at = ?
    WHERE guild_id = ?
      AND invite_code = ?
  `),

  updateInviteUses: database.prepare(`
    UPDATE referral_invites
    SET last_known_uses = ?
    WHERE guild_id = ?
      AND invite_code = ?
  `),

  createAttribution: database.prepare(`
    INSERT OR IGNORE INTO referral_attributions (
      guild_id,
      referred_user_id,
      inviter_user_id,
      invite_code,
      joined_at,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `),

  getPendingReferrals: database.prepare(`
    SELECT
      guild_id,
      referred_user_id,
      inviter_user_id,
      invite_code,
      joined_at
    FROM referral_attributions
    WHERE guild_id = ?
      AND status = 'pending'
      AND joined_at <= ?
  `),

  getReferralStatus: database.prepare(`
    SELECT status
    FROM referral_attributions
    WHERE guild_id = ?
      AND referred_user_id = ?
  `),

  qualifyReferral: database.prepare(`
    UPDATE referral_attributions
    SET
      status = 'qualified',
      qualified_at = ?,
      updated_at = ?
    WHERE guild_id = ?
      AND referred_user_id = ?
      AND status = 'pending'
  `),

  markReferralLeft: database.prepare(`
    UPDATE referral_attributions
    SET
      status = CASE
        WHEN status = 'pending' THEN 'left'
        ELSE status
      END,
      left_at = ?,
      updated_at = ?
    WHERE guild_id = ?
      AND referred_user_id = ?
  `),

  addPoints: database.prepare(`
    INSERT OR IGNORE INTO referral_point_transactions (
      guild_id,
      user_id,
      referred_user_id,
      transaction_type,
      points,
      reason,
      created_at
    )
    VALUES (?, ?, ?, 'qualification', ?, ?, ?)
  `),

  getReferralCounts: database.prepare(`
    SELECT
      COALESCE(
        SUM(
          CASE
            WHEN status = 'qualified' THEN 1
            ELSE 0
          END
        ),
        0
      ) AS qualified,

      COALESCE(
        SUM(
          CASE
            WHEN status = 'pending' THEN 1
            ELSE 0
          END
        ),
        0
      ) AS pending,

      COALESCE(
        SUM(
          CASE
            WHEN status = 'left' THEN 1
            ELSE 0
          END
        ),
        0
      ) AS left_count

    FROM referral_attributions
    WHERE guild_id = ?
      AND inviter_user_id = ?
  `),

  getPointTotal: database.prepare(`
    SELECT
      COALESCE(SUM(points), 0) AS total
    FROM referral_point_transactions
    WHERE guild_id = ?
      AND user_id = ?
  `),

  getLeaderboard: database.prepare(`
    SELECT
      attribution.inviter_user_id AS user_id,
      COUNT(*) AS qualified,
      COALESCE(
        (
          SELECT SUM(points.points)
          FROM referral_point_transactions AS points
          WHERE points.guild_id = attribution.guild_id
            AND points.user_id =
              attribution.inviter_user_id
        ),
        0
      ) AS points

    FROM referral_attributions AS attribution

    WHERE attribution.guild_id = ?
      AND attribution.status = 'qualified'

    GROUP BY attribution.inviter_user_id

    ORDER BY
      points DESC,
      qualified DESC

    LIMIT ?
  `),
  getStripeAccountForUser: database.prepare(`
    SELECT
      discord_user_id,
      stripe_account_id,
      onboarding_status,
      charges_enabled,
      payouts_enabled,
      created_at,
      updated_at
    FROM creator_stripe_accounts
    WHERE discord_user_id = ?
    LIMIT 1
  `),

  saveStripeAccountForUser: database.prepare(`
    INSERT INTO creator_stripe_accounts (
      discord_user_id,
      stripe_account_id,
      onboarding_status,
      charges_enabled,
      payouts_enabled,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_user_id)
    DO UPDATE SET
      stripe_account_id = excluded.stripe_account_id,
      onboarding_status = excluded.onboarding_status,
      charges_enabled = excluded.charges_enabled,
      payouts_enabled = excluded.payouts_enabled,
      updated_at = excluded.updated_at
  `),

};

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

const inviteCache = new Map();
let qualificationJobRunning = false;

/*
|--------------------------------------------------------------------------
| Utility functions
|--------------------------------------------------------------------------
*/

function nowIso() {
  return new Date().toISOString();
}

function logError(context, error) {
  console.error(`[${context}]`, error);
}

function getUserStatistics(guildId, userId) {
  const counts = statements.getReferralCounts.get(
    guildId,
    userId,
  );

  const points = statements.getPointTotal.get(
    guildId,
    userId,
  );

  return {
    qualified: Number(counts?.qualified || 0),
    pending: Number(counts?.pending || 0),
    left: Number(counts?.left_count || 0),
    points: Number(points?.total || 0),
  };
}

/*
|--------------------------------------------------------------------------
| Stripe Connect
|--------------------------------------------------------------------------
*/

function saveStripeAccount(discordUserId, account) {
  const timestamp = nowIso();

  statements.saveStripeAccountForUser.run(
    discordUserId,
    account.id,
    account.details_submitted ? 'complete' : 'pending',
    account.charges_enabled ? 1 : 0,
    account.payouts_enabled ? 1 : 0,
    timestamp,
    timestamp,
  );
}

async function getOrCreateCreatorStripeAccount(discordUserId) {
  const existing =
    statements.getStripeAccountForUser.get(
      discordUserId,
    );

  if (existing) {
    try {
      const account = await stripe.accounts.retrieve(
        existing.stripe_account_id,
      );

      saveStripeAccount(discordUserId, account);

      return account;
    } catch (error) {
      if (
        error?.code !== 'resource_missing'
      ) {
        throw error;
      }
    }
  }

  const account = await stripe.accounts.create({
    type: 'express',
    metadata: {
      discord_user_id: discordUserId,
    },
  });

  saveStripeAccount(discordUserId, account);

  return account;
}

async function createCreatorStripeUrl(discordUserId) {
  const account =
    await getOrCreateCreatorStripeAccount(
      discordUserId,
    );

  const partnerLinksBaseUrl =
    'https:' + '//partnerlinks.app';

  return {
    url:
      partnerLinksBaseUrl +
      '/stripe/connect/start?account=' +
      encodeURIComponent(account.id),
    connected:
      account.details_submitted &&
      account.payouts_enabled,
  };
}

/*
|--------------------------------------------------------------------------
| Referral panel
|--------------------------------------------------------------------------
*/

function createReferralPanel() {
  const embed = new EmbedBuilder()
    .setTitle('UGC NETWORK')
    .setDescription(
      [
        '**Referral Program**',
        '',
        'Invite brands to UGC NETWORK **Discord** using your unique link. If a brand signs up for a paid affiliate or management plan, you earn **33% of their monthly plan recurring revenue** for as long as we work with that brand.',
        '',
        '**How it works**',
        '1. Click **Create Link**',
        '2. Share your link with brands',
        '3. Earn **33% recurring revenue** on every brand that signs up',
        '',
        '```ansi',
        '\u001b[32mOnce a brand joins through your link, the referral is yours forever. If they ever become a client, you’ll automatically be added to their payment schedule. Check referrals and subscription status in My Referrals.\u001b[0m',
        '```',
      ].join('\n'),
    );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('referral:create')
      .setLabel('🔗 Create Link')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('referral:stats')
      .setLabel('💰 My Referrals')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('referral:stripe')
      .setLabel('▰ Stripe')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    embeds: [embed],
    components: [actionRow],
  };
}

/*
|--------------------------------------------------------------------------
| Invite management
|--------------------------------------------------------------------------
*/

async function fetchGuildInviteSnapshot(guild) {
  const invites = await guild.invites.fetch();
  const snapshot = new Map();

  for (const invite of invites.values()) {
    snapshot.set(invite.code, invite.uses || 0);
  }

  return {
    invites,
    snapshot,
  };
}

async function refreshInviteCache(guild) {
  const { snapshot } =
    await fetchGuildInviteSnapshot(guild);

  inviteCache.set(guild.id, snapshot);

  console.log(
    `Cached ${snapshot.size} active invite(s) for ${guild.name}.`,
  );
}

async function getOrCreateReferralInvite(guild, user) {
  const existingRecord =
    statements.getActiveInviteForUser.get(
      guild.id,
      user.id,
    );

  if (existingRecord) {
    const currentInvites = await guild.invites.fetch();

    const existingInvite = currentInvites.get(
      existingRecord.invite_code,
    );

    if (existingInvite) {
      return existingInvite;
    }

    statements.deactivateInvite.run(
      nowIso(),
      guild.id,
      existingRecord.invite_code,
    );
  }

  const entryChannel = await guild.channels.fetch(
    config.entryChannelId,
  );

  if (!entryChannel) {
    throw new Error(
      'The configured referral entry channel does not exist.',
    );
  }

  if (!entryChannel.isTextBased()) {
    throw new Error(
      'The configured referral entry channel is not a text channel.',
    );
  }

  const invite = await guild.invites.create(
    entryChannel.id,
    {
      maxAge: 0,
      maxUses: 0,
      temporary: false,
      unique: true,
      reason:
        `Referral invite requested by ${user.tag} (${user.id})`,
    },
  );

  const timestamp = nowIso();
  const inviteUses = invite.uses || 0;

  statements.saveInvite.run(
    invite.code,
    guild.id,
    entryChannel.id,
    user.id,
    inviteUses,
    timestamp,
  );

  const cachedInvites =
    inviteCache.get(guild.id) || new Map();

  cachedInvites.set(invite.code, inviteUses);
  inviteCache.set(guild.id, cachedInvites);

  console.log(
    `Created referral invite ${invite.code} for ${user.tag}.`,
  );

  return invite;
}

/*
|--------------------------------------------------------------------------
| Join attribution
|--------------------------------------------------------------------------
*/

async function attributeNewMember(member) {
  if (member.user.bot) {
    return;
  }

  if (member.guild.id !== config.guildId) {
    return;
  }

  const previousSnapshot =
    inviteCache.get(member.guild.id) || new Map();

  const { invites, snapshot } =
    await fetchGuildInviteSnapshot(member.guild);

  inviteCache.set(member.guild.id, snapshot);

  const increasedInvites = [];

  for (const invite of invites.values()) {
    const previousUses =
      previousSnapshot.get(invite.code) || 0;

    const currentUses = invite.uses || 0;

    if (currentUses > previousUses) {
      increasedInvites.push({
        invite,
        increase: currentUses - previousUses,
      });
    }
  }

  if (increasedInvites.length !== 1) {
    console.warn(
      [
        `Unable to identify one exact invite for ${member.user.tag}.`,
        `Detected ${increasedInvites.length} increased invite(s).`,
      ].join(' '),
    );

    return;
  }

  const usedInvite = increasedInvites[0].invite;

  const referralRecord =
    statements.getInviteOwner.get(
      member.guild.id,
      usedInvite.code,
    );

  statements.updateInviteUses.run(
    usedInvite.uses || 0,
    member.guild.id,
    usedInvite.code,
  );

  if (!referralRecord) {
    console.log(
      `${member.user.tag} joined with a non-referral invite.`,
    );

    return;
  }

  if (referralRecord.owner_user_id === member.id) {
    console.warn(
      `${member.user.tag} attempted to use their own referral invite.`,
    );

    return;
  }

  const timestamp = nowIso();

  const result = statements.createAttribution.run(
    member.guild.id,
    member.id,
    referralRecord.owner_user_id,
    usedInvite.code,
    timestamp,
    timestamp,
    timestamp,
  );

  if (result.changes === 0) {
    console.log(
      `${member.user.tag} already has a referral attribution record.`,
    );

    return;
  }

  console.log(
    [
      `Attributed ${member.user.tag}`,
      `to inviter ${referralRecord.owner_user_id}`,
      `using invite ${usedInvite.code}.`,
    ].join(' '),
  );
}

/*
|--------------------------------------------------------------------------
| Referral qualification
|--------------------------------------------------------------------------
*/

const qualifyReferralTransaction = database.transaction(
  (referral) => {
    const currentRecord =
      statements.getReferralStatus.get(
        referral.guild_id,
        referral.referred_user_id,
      );

    if (!currentRecord) {
      return false;
    }

    if (currentRecord.status !== 'pending') {
      return false;
    }

    const timestamp = nowIso();

    const qualificationResult =
      statements.qualifyReferral.run(
        timestamp,
        timestamp,
        referral.guild_id,
        referral.referred_user_id,
      );

    if (qualificationResult.changes === 0) {
      return false;
    }

    statements.addPoints.run(
      referral.guild_id,
      referral.inviter_user_id,
      referral.referred_user_id,
      config.pointsPerReferral,
      'Qualified Discord referral',
      timestamp,
    );

    return true;
  },
);

async function qualifyPendingReferrals(client) {
  if (qualificationJobRunning) {
    return;
  }

  qualificationJobRunning = true;

  try {
    const cutoffTimestamp = new Date(
      Date.now() -
        config.qualificationHours * 60 * 60 * 1000,
    ).toISOString();

    const pendingReferrals =
      statements.getPendingReferrals.all(
        config.guildId,
        cutoffTimestamp,
      );

    if (pendingReferrals.length === 0) {
      return;
    }

    const guild = await client.guilds.fetch(
      config.guildId,
    );

    for (const referral of pendingReferrals) {
      let referredMember;

      try {
        referredMember = await guild.members.fetch(
          referral.referred_user_id,
        );
      } catch {
        const timestamp = nowIso();

        statements.markReferralLeft.run(
          timestamp,
          timestamp,
          referral.guild_id,
          referral.referred_user_id,
        );

        console.log(
          `Referral ${referral.referred_user_id} left before qualifying.`,
        );

        continue;
      }

      if (
        config.verifiedRoleId &&
        !referredMember.roles.cache.has(
          config.verifiedRoleId,
        )
      ) {
        continue;
      }

      const qualified =
        qualifyReferralTransaction(referral);

      if (qualified) {
        console.log(
          [
            `Qualified referral ${referral.referred_user_id}.`,
            `Awarded ${config.pointsPerReferral} points`,
            `to ${referral.inviter_user_id}.`,
          ].join(' '),
        );
      }
    }
  } finally {
    qualificationJobRunning = false;
  }
}

/*
|--------------------------------------------------------------------------
| Slash command registration
|--------------------------------------------------------------------------
*/

async function registerCommands() {
  const setupCommand = new SlashCommandBuilder()
    .setName('setup-referrals')
    .setDescription(
      'Post the referral program panel.',
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    );

  const rest = new REST({
    version: '10',
  }).setToken(config.token);

  await rest.put(
    Routes.applicationGuildCommands(
      config.clientId,
      config.guildId,
    ),
    {
      body: [setupCommand.toJSON()],
    },
  );

  console.log(
    'Registered the /setup-referrals command.',
  );
}

/*
|--------------------------------------------------------------------------
| Discord client
|--------------------------------------------------------------------------
*/

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

/*
|--------------------------------------------------------------------------
| Ready event
|--------------------------------------------------------------------------
*/

client.once(Events.ClientReady, async (readyClient) => {
  try {
    console.log(
      `Logged in as ${readyClient.user.tag}.`,
    );

    await registerCommands();

    const guild = await readyClient.guilds.fetch(
      config.guildId,
    );

    await refreshInviteCache(guild);
    await qualifyPendingReferrals(readyClient);

    const panelChannel = await guild.channels.fetch(
      config.panelChannelId,
    );

    if (
      !panelChannel ||
      !panelChannel.isTextBased() ||
      typeof panelChannel.send !== 'function'
    ) {
      throw new Error(
        'The configured referral panel channel cannot receive messages.',
      );
    }

    const recentMessages = await panelChannel.messages.fetch({
      limit: 50,
    });

    const existingPanel = recentMessages.find(
      (message) =>
        message.author.id === readyClient.user.id &&
        message.embeds.some(
          (embed) => embed.title === 'UGC NETWORK',
        ),
    );

    if (!existingPanel) {
      await panelChannel.send(createReferralPanel());
      console.log('Referral panel posted automatically.');
    } else {
      console.log('Referral panel already exists.');
    }

    const interval = setInterval(() => {
      qualifyPendingReferrals(readyClient).catch(
        (error) => {
          logError(
            'Referral qualification interval',
            error,
          );
        },
      );
    }, 5 * 60 * 1000);

    interval.unref();

    console.log('Referral bot is ready.');
  } catch (error) {
    logError('Client ready setup', error);
    process.exitCode = 1;
  }
});

/*
|--------------------------------------------------------------------------
| Interaction handling
|--------------------------------------------------------------------------
*/

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (!interaction.inGuild()) {
      return;
    }

    if (interaction.guildId !== config.guildId) {
      return;
    }

    /*
    |--------------------------------------------------------------------------
    | /setup-referrals
    |--------------------------------------------------------------------------
    */

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'setup-referrals'
    ) {
      try {
        if (
          !interaction.memberPermissions?.has(
            PermissionFlagsBits.Administrator,
          )
        ) {
          await interaction.reply({
            content:
              'You must be a server administrator to use this command.',
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({
          ephemeral: true,
        });

        const panelChannel =
          await interaction.guild.channels.fetch(
            config.panelChannelId,
          );

        if (!panelChannel) {
          await interaction.editReply(
            'The configured referral panel channel could not be found.',
          );

          return;
        }

        if (
          !panelChannel.isTextBased() ||
          typeof panelChannel.send !== 'function'
        ) {
          await interaction.editReply(
            'The configured referral panel channel cannot receive messages.',
          );

          return;
        }

        const panelMessage =
          await panelChannel.send(
            createReferralPanel(),
          );

        await interaction.editReply(
          `Referral panel posted successfully: ${panelMessage.url}`,
        );
      } catch (error) {
        logError('/setup-referrals', error);

        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply(
            'The referral panel could not be posted. Check the Terminal logs.',
          );
        } else {
          await interaction.reply({
            content:
              'The referral panel could not be posted. Check the Terminal logs.',
            ephemeral: true,
          });
        }
      }

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | Referral buttons
    |--------------------------------------------------------------------------
    */

    if (!interaction.isButton()) {
      return;
    }

    if (
      !interaction.customId.startsWith(
        'referral:',
      )
    ) {
      return;
    }

    try {
      await interaction.deferReply({
        ephemeral: true,
      });

      /*
      |--------------------------------------------------------------------------
      | Create referral link
      |--------------------------------------------------------------------------
      */

      if (
        interaction.customId ===
        'referral:create'
      ) {
        const invite =
          await getOrCreateReferralInvite(
            interaction.guild,
            interaction.user,
          );

        const statistics = getUserStatistics(
          interaction.guildId,
          interaction.user.id,
        );

        await interaction.editReply(
          [
            '**Your permanent invite link**',
            invite.url,
            '',
            `Invites: **${statistics.qualified}**`,
                                    '',
            'Share this link to invite creators to UGC Network.',
          ].join('\n'),
        );

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Personal statistics
      |--------------------------------------------------------------------------
      */

      if (
        interaction.customId ===
        'referral:stats'
      ) {
        const statistics = getUserStatistics(
          interaction.guildId,
          interaction.user.id,
        );

        await interaction.editReply(
          [
            '**Your referral statistics**',
            '',
            `Invites: **${statistics.qualified}**`,
                        `Did not qualify: **${statistics.left}**`,
            `Total points: **${statistics.points}**`,
          ].join('\n'),
        );

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Stripe Connect
      |--------------------------------------------------------------------------
      */

      if (
        interaction.customId ===
        'referral:stripe'
      ) {
        const stripeResult =
          await createCreatorStripeUrl(
            interaction.user.id,
          );

        await interaction.editReply(
          stripeResult.connected
            ? [
                '**Stripe connected**',
                '',
                'Your Stripe account is ready for payouts.',
                '',
                stripeResult.url,
              ].join('\n')
            : [
                '**Set up Stripe**',
                '',
                'Complete Stripe setup so PartnerLinks can send your referral payouts.',
                '',
                stripeResult.url,
              ].join('\n'),
        );

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | Leaderboard
      |--------------------------------------------------------------------------
      */

      if (
        interaction.customId ===
        'referral:leaderboard'
      ) {
        const leaderboard =
          statements.getLeaderboard.all(
            interaction.guildId,
            config.leaderboardLimit,
          );

        if (leaderboard.length === 0) {
          await interaction.editReply(
            '**Referral leaderboard**\n\nNo qualified referrals yet.',
          );

          return;
        }

        const rows = leaderboard.map(
          (row, index) => {
            return [
              `${index + 1}. <@${row.user_id}>`,
              `— **${row.points} points**`,
              `(${row.qualified} referrals)`,
            ].join(' ');
          },
        );

        await interaction.editReply(
          [
            '**Referral leaderboard**',
            '',
            ...rows,
          ].join('\n'),
        );
      }
    } catch (error) {
      logError(
        `Button ${interaction.customId}`,
        error,
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.editReply(
          'The bot could not complete that action. Check the Terminal logs.',
        );
      } else {
        await interaction.reply({
          content:
            'The bot could not complete that action. Check the Terminal logs.',
          ephemeral: true,
        });
      }
    }
  },
);

/*
|--------------------------------------------------------------------------
| Invite lifecycle events
|--------------------------------------------------------------------------
*/

client.on(Events.InviteCreate, (invite) => {
  if (invite.guild.id !== config.guildId) {
    return;
  }

  const cachedInvites =
    inviteCache.get(invite.guild.id) ||
    new Map();

  cachedInvites.set(
    invite.code,
    invite.uses || 0,
  );

  inviteCache.set(
    invite.guild.id,
    cachedInvites,
  );
});

client.on(Events.InviteDelete, (invite) => {
  if (invite.guild.id !== config.guildId) {
    return;
  }

  const cachedInvites =
    inviteCache.get(invite.guild.id);

  if (cachedInvites) {
    cachedInvites.delete(invite.code);
  }

  statements.deactivateInvite.run(
    nowIso(),
    invite.guild.id,
    invite.code,
  );
});

/*
|--------------------------------------------------------------------------
| Member join and leave events
|--------------------------------------------------------------------------
*/

client.on(Events.GuildMemberAdd, (member) => {
  attributeNewMember(member).catch((error) => {
    logError(
      `Member join ${member.user.tag}`,
      error,
    );
  });
});

client.on(Events.GuildMemberRemove, (member) => {
  if (member.guild.id !== config.guildId) {
    return;
  }

  if (member.user.bot) {
    return;
  }

  const timestamp = nowIso();

  statements.markReferralLeft.run(
    timestamp,
    timestamp,
    member.guild.id,
    member.id,
  );

  console.log(
    `${member.user.tag} left the server.`,
  );
});

/*
|--------------------------------------------------------------------------
| Discord and process errors
|--------------------------------------------------------------------------
*/

client.on(Events.Error, (error) => {
  logError('Discord client error', error);
});

client.on(Events.Warn, (warning) => {
  console.warn('[Discord warning]', warning);
});

process.on(
  'unhandledRejection',
  (reason) => {
    logError('Unhandled promise rejection', reason);
  },
);

process.on(
  'uncaughtException',
  (error) => {
    logError('Uncaught exception', error);
  },
);

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

function shutDown(signal) {
  console.log(
    `Received ${signal}. Shutting down.`,
  );

  try {
    database.close();
  } catch (error) {
    logError('Database shutdown', error);
  }

  client.destroy();
  process.exit(0);
}

process.once('SIGINT', () => {
  shutDown('SIGINT');
});

process.once('SIGTERM', () => {
  shutDown('SIGTERM');
});

/*
|--------------------------------------------------------------------------
| Login
|--------------------------------------------------------------------------
*/

client.login(config.token).catch((error) => {
  logError('Discord login', error);
  process.exit(1);
});
