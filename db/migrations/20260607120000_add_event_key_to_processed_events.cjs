/**
 * Adds a canonical event_key to processed_events for robust Soroban idempotency.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('processed_events', (table) => {
    table.text('event_key')
  })

  await knex.raw(
    `UPDATE processed_events
     SET event_key = transaction_hash || ':' || ledger_number || ':' || event_index`
  )

  await knex.schema.alterTable('processed_events', (table) => {
    table.text('event_key').notNullable().unique().alter()
  })

  await knex.schema.alterTable('processed_events', (table) => {
    table.index(['event_key'], 'idx_processed_events_event_key')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('processed_events', (table) => {
    table.dropIndex(['event_key'], 'idx_processed_events_event_key')
  })

  await knex.schema.alterTable('processed_events', (table) => {
    table.dropColumn('event_key')
  })
}
