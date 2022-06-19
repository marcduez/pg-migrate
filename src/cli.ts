#!/usr/bin/env node
/* eslint-disable no-console */
import path from "path"
import { Client } from "pg"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { createDatabaseMigration, migrateDatabase } from "."

yargs(hideBin(process.argv))
  .usage("Usage: $0 <command> [options]")
  .showHelpOnFail(false)

  // Migrate database
  .command({
    command: "migrate",
    describe: "Apply un-applied database migrations",
    builder: {
      "migration-dir": {
        alias: "d",
        default: "migrations",
        describe: "The migration directory to use",
      },
      "migration-table": {
        alias: "t",
        default: "migrations",
        describe: "The migration table name to use",
      },
      host: {
        alias: "h",
        defaultDescription: '"localhost"',
        describe:
          "Database server host or socket directory (or set PGHOST env variable)",
      },
      port: {
        alias: "p",
        defaultDescription: "5432",
        number: true,
        describe: "Database server port (or set PGPORT env variable)",
      },
      database: {
        alias: "D",
        describe:
          "Database name to connect to (or set PGDATABASE env variable)",
      },
      username: {
        alias: "U",
        defaultDescription: '"postgres"',
        describe: "Database user name (or set PGUSER env variable)",
      },
      password: {
        alias: "W",
        describe: "Database password (or set PGPASSWORD env variable)",
      },
    },
    handler: async ({
      migrationDir,
      migrationTable,
      host,
      port,
      database,
      username,
      password,
    }: {
      migrationDir: string
      migrationTable: string
      host?: string
      port?: number
      database?: string
      username?: string
      password?: string
    }) => {
      const resolvedMigrationDir = path.join(process.cwd(), migrationDir)
      const resolvedHost = host ?? process.env.PGHOST ?? "localhost"
      const resolvedPort = port ?? parseInt(process.env.PGPORT ?? "5432", 10)
      const resolvedDatabase =
        database ?? process.env.PGDATABASE ?? "__no_database_provided__"
      const resolvedUsername = username ?? process.env.PGUSER ?? "postgres"
      const resolvedPassword = password ?? process.env.PGPASSWORD

      const client = new Client({
        host: resolvedHost,
        port: resolvedPort,
        database: resolvedDatabase,
        user: resolvedUsername,
        password: resolvedPassword,
      })

      await client.connect()
      try {
        await migrateDatabase(client, resolvedMigrationDir, migrationTable)
      } finally {
        await client.end()
      }
    },
  })

  // Create migration
  .command({
    command: "create",
    describe: "Create a database migration",
    builder: {
      "migration-dir": {
        alias: "d",
        default: "migrations",
        describe: "The migration directory to use",
      },
    },
    handler: async ({ migrationDir }: { migrationDir: string }) => {
      const resolvedMigrationDir = path.join(process.cwd(), migrationDir)
      const filePath = await createDatabaseMigration(resolvedMigrationDir)
      console.log(`Database migration created: ${filePath}`)
    },
  })

  .demandCommand()

  .parse()
