/**
 * Adds a residency label to enterprises and pins read queries to the matching
 * regional read replica when configured.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('organizations', (table) => {
    table.enu('residency', ['EU', 'US'], {
      useNative: true,
      enumName: 'residency_enum',
    }).nullable()
  })

  // Backfill residency when it can be derived from organization metadata.
  await knex.raw(`
    UPDATE organizations
    SET residency = upper(metadata->>'residency')
    WHERE metadata ? 'residency'
      AND upper(metadata->>'residency') IN ('EU', 'US')
  `)

  await knex.raw(`
    UPDATE organizations
    SET residency = upper(metadata->>'region')
    WHERE residency IS NULL
      AND metadata ? 'region'
      AND upper(metadata->>'region') IN ('EU', 'US')
  `)
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('residency')
  })

  await knex.raw('DROP TYPE IF EXISTS residency_enum')
}
