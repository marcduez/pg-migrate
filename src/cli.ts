#!/usr/bin/env node
import path from "path"
import { Client } from "pg"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
  createDatabaseMigration,
  migrateDatabase,
  overwriteDatabaseMd5,
} from "."
import inquirer from "inquirer"

const getClient = ({
  host,
  port,
  database,
  username,
  password,
  connectionString,
}: {
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string
  connectionString?: string
}) => {
  const resolvedConnectionString =
    connectionString ?? process.env.PGURI ?? process.env.DATABASE_URL
  if (resolvedConnectionString) {
    return new Client({
      connectionString: resolvedConnectionString,
    })
  } else {
    const resolvedHost = host ?? process.env.PGHOST ?? "localhost"
    const resolvedPort = port ?? parseInt(process.env.PGPORT ?? "5432", 10)
    const resolvedDatabase =
      database ?? process.env.PGDATABASE ?? "__no_database_provided__"
    const resolvedUsername = username ?? process.env.PGUSER ?? "postgres"
    const resolvedPassword = password ?? process.env.PGPASSWORD

    return new Client({
      host: resolvedHost,
      port: resolvedPort,
      database: resolvedDatabase,
      user: resolvedUsername,
      password: resolvedPassword,
    })
  }
}

yargs(hideBin(process.argv))
  .usage("Usage: $0 <command> [options]")
  .showHelpOnFail(true)

  // Create migration
  .command<{ migrationName: string; migrationDir: string }>({
    command: "create [migration-name]",
    describe: "Create a database migration",
    builder: {
      "migration-dir": {
        alias: "d",
        default: "migrations",
        describe: "The migration directory to use",
      },
    },
    handler: async ({ migrationDir }) => {
      const { migrationName } = await inquirer.prompt<{
        migrationName: string
      }>([
        {
          default: "",
          message: "Migration name (optional):",
          name: "migrationName",
          type: "string",
        },
      ])

      const resolvedMigrationDir = path.join(process.cwd(), migrationDir)
      const filePath = await createDatabaseMigration(
        migrationName,
        resolvedMigrationDir,
      )
      console.log(`Database migration created: ${filePath}`)
    },
  })

  // Migrate database
  .command<{
    migrationDir: string
    migrationTable: string
    host?: string
    port?: number
    database?: string
    username?: string
    password?: string
    connectionString: string
  }>({
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
      "connection-string": {
        describe:
          "Database connection string (or set PGURI or DATABASE_URL env variable)",
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
      connectionString,
    }) => {
      const resolvedMigrationDir = path.join(process.cwd(), migrationDir)
      const client = getClient({
        host,
        port,
        database,
        username,
        password,
        connectionString,
      })
      await client.connect()
      try {
        await migrateDatabase(client, resolvedMigrationDir, migrationTable)
      } finally {
        await client.end()
      }
    },
  })

  // Overwrite MD5
  .command<{
    migrationDir: string
    migrationTable: string
    host?: string
    port?: number
    database?: string
    username?: string
    password?: string
    connectionString: string
  }>({
    command: "overwrite-md5",
    describe:
      "Overwrite the MD5 digest of a migration in a database with the MD5 digest from the migration file",
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
      "connection-string": {
        describe:
          "Database connection string (or set PGURI or DATABASE_URL env variable)",
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
      connectionString,
    }) => {
      const { migrationFilename } = await inquirer.prompt<{
        migrationFilename: string
      }>([
        {
          message: "Migration file",
          name: "migrationFilename",
          type: "string",
        },
      ])

      const migrationFilePath = path.join(
        process.cwd(),
        migrationDir,
        migrationFilename,
      )
      const client = getClient({
        host,
        port,
        database,
        username,
        password,
        connectionString,
      })
      await client.connect()
      try {
        await overwriteDatabaseMd5(client, migrationFilePath, migrationTable)
      } finally {
        await client.end()
      }
    },
  })

  .demandCommand()

  .parse()
