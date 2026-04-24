import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { roles } from './roles.js'

export const botInstances = sqliteTable('bot_instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform', { enum: ['discord', 'qq'] }).notNull(),
  token: text('token').notNull(),
  llmProvider: text('llm_provider').notNull().default('openai'),
  llmPlatformName: text('llm_platform_name').notNull().default(''),
  llmModel: text('llm_model').notNull().default(''),
  llmApiKey: text('llm_api_key').notNull().default(''),
  llmBaseUrl: text('llm_base_url').notNull().default(''),
  discordUserId: text('discord_user_id').notNull().default(''),
  discordChannelId: text('discord_channel_id').notNull().default(''),
  discordGuildId: text('discord_guild_id').notNull().default(''),
  roleId: text('role_id')
    .notNull()
    .references(() => roles.id, { onDelete: 'restrict' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Whether the bot only responds when @mentioned (false = responds to all messages in channel) */
  requireMention: integer('require_mention', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export type BotInstanceRow = typeof botInstances.$inferSelect
export type NewBotInstanceRow = typeof botInstances.$inferInsert
