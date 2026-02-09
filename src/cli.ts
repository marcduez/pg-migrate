#!/usr/bin/env node
import { confirm, input } from "@inquirer/prompts"
import path from "path"
import { Client } from "pg"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
  createDatabaseMigration,
  migrateDatabase,
  migrateV2ToV3,
  overwriteDatabaseMd5,
} from "."

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
      const migrationName = await input({
        default: "",
        message: "Migration name (optional):",
      })

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
    pgDumpPath: string
    schemaFile: string
    timeoutSeconds?: number
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
        describe: "Directory where all the migration files are located",
      },
      "migration-table": {
        alias: "t",
        default: "migrations",
        describe: "Database table that tracks previously applied migrations",
      },
      "pg-dump-path": {
        alias: "b",
        default: "pg_dump",
        describe:
          "Path to the pg_dump executable used to write the database schema (set to empty string to skip writing schema)",
      },
      "schema-file": {
        alias: "s",
        default: "schema.sql",
        describe:
          "File that the database schema will be written to after applying migrations (set to empty string to skip writing schema)",
      },
      "timeout-seconds": {
        alias: "T",
        describe: "Maximum allowed migration timeout, in seconds",
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
      pgDumpPath,
      schemaFile,
      timeoutSeconds,
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
        await migrateDatabase(
          client,
          resolvedMigrationDir,
          migrationTable,
          pgDumpPath,
          schemaFile,
          timeoutSeconds,
        )
      } finally {
        await client.end()
      }
    },
  })

  // Migrate from v2 to v3
  .command<{
    migrationDir: string
    migrationTable: string
    pgDumpPath: string
    schemaFile: string
    host?: string
    port?: number
    database?: string
    username?: string
    password?: string
    connectionString: string
  }>({
    command: "migrate-v2-to-v3",
    describe: "Migrate a system using v2 of pg-migrate to v3 of pg-migrate",
    builder: {
      "migration-dir": {
        alias: "d",
        default: "migrations",
        describe: "Directory where all the migration files are located",
      },
      "migration-table": {
        alias: "t",
        default: "migrations",
        describe: "Database table that tracks previously applied migrations",
      },
      "pg-dump-path": {
        alias: "b",
        default: "pg_dump",
        describe:
          "Path to the pg_dump executable used to write the database schema (set to empty string to skip writing schema)",
      },
      "schema-file": {
        alias: "s",
        default: "schema.sql",
        describe:
          "File that the database schema will be written to after applying migrations (set to empty string to skip writing schema)",
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
      pgDumpPath,
      schemaFile,
      host,
      port,
      database,
      username,
      password,
      connectionString,
    }) => {
      const isFullyMigrated = await confirm({
        default: false,
        message:
          "Do not run this command until your database is fully migrated. Is it fully migrated?",
      })

      if (!isFullyMigrated) {
        console.log(
          "Aborting migration because the database is not fully migrated",
        )
        return
      }

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
        await migrateV2ToV3(
          client,
          resolvedMigrationDir,
          migrationTable,
          pgDumpPath,
          schemaFile,
        )
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
      const migrationFilename = await input({
        message: "Migration file:",
        validate: value => !!value,
      })

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
