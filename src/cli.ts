#!/usr/bin/env node
import { confirm, input } from "@inquirer/prompts"
import path from "path"
import { Client } from "pg"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
  createDatabaseMigration,
  dumpSchemaToFile,
  migrateDatabase,
  migrateV2ToV3,
  overwriteDatabaseMd5,
} from "./index.js"

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
  .showHelpOnFail(false)

  // Create migration
  .command<{
    migrationDir: string
    migrationName: string
  }>({
    command: "create [migration-name]",
    describe: "Create a database migration",
    builder: {
      "migration-dir": {
        alias: "d",
        default: "migrations",
        describe: "The migration directory to use",
      },
    },
    handler: async ({ migrationDir, migrationName: migrationNameFromArgs }) => {
      const migrationName =
        migrationNameFromArgs ??
        (await input({
          default: "",
          message: "Migration name (optional):",
        }))

      const resolvedMigrationDir = path.isAbsolute(migrationDir)
        ? migrationDir
        : path.resolve(process.cwd(), migrationDir)
      const filePath = await createDatabaseMigration(
        migrationName,
        resolvedMigrationDir,
      )
      console.log(`Database migration created: ${filePath}`)
    },
  })

  // Migrate database
  .command<{
    connectionString: string
    database?: string
    host?: string
    migrationDir: string
    migrationTable: string
    password?: string
    port?: number
    schemaFile: string
    throwOnChangedSchema: boolean
    timeoutSeconds?: number
    username?: string
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
      "schema-file": {
        alias: "s",
        default: "schema.sql",
        describe:
          "File that the database schema will be written to after applying migrations (set to empty string to skip writing schema)",
      },
      "throw-on-changed-schema": {
        alias: "c",
        default: false,
        describe:
          "If set, pg-migrate will throw an error if it detects that the database schema was changed by applying migrations",
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
      connectionString,
      database,
      host,
      migrationDir,
      migrationTable,
      password,
      port,
      schemaFile,
      throwOnChangedSchema,
      timeoutSeconds,
      username,
    }) => {
      const resolvedMigrationDir = path.isAbsolute(migrationDir)
        ? migrationDir
        : path.resolve(process.cwd(), migrationDir)
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
          schemaFile,
          throwOnChangedSchema,
          timeoutSeconds,
        )
      } finally {
        await client.end()
      }
    },
  })

  // Migrate from v2 to v3
  .command<{
    connectionString: string
    database?: string
    host?: string
    migrationDir: string
    migrationTable: string
    password?: string
    port?: number
    schemaFile: string
    username?: string
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
      connectionString,
      database,
      host,
      migrationDir,
      migrationTable,
      password,
      port,
      schemaFile,
      username,
    }) => {
      const isFullyMigrated = await confirm({
        default: false,
        message:
          "WARNING: This script will drop and recreate the migrations table and rename your migration files. You should run this after you have migrated your database to latest. Proceed?",
      })

      if (!isFullyMigrated) {
        console.log("Aborting")
        return
      }

      const resolvedMigrationDir = path.isAbsolute(migrationDir)
        ? migrationDir
        : path.resolve(process.cwd(), migrationDir)
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
          schemaFile,
        )
      } finally {
        await client.end()
      }
    },
  })

  // Overwrite MD5
  .command<{
    connectionString: string
    database?: string
    host?: string
    migrationDir: string
    migrationFilename: string
    migrationTable: string
    password?: string
    port?: number
    username?: string
  }>({
    command: "overwrite-md5 [migration-filename]",
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
      connectionString,
      database,
      host,
      migrationDir,
      migrationFilename: migrationFilenameFromArgs,
      migrationTable,
      password,
      port,
      username,
    }) => {
      const migrationFilename =
        migrationFilenameFromArgs ??
        (await input({
          message: "Migration file:",
          validate: value => !!value,
        }))

      const resolvedMigrationDir = path.isAbsolute(migrationDir)
        ? migrationDir
        : path.resolve(process.cwd(), migrationDir)
      const migrationFilePath = path.join(
        resolvedMigrationDir,
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

  .command({
    command: "dump-schema",
    describe: "Write a dump of the database schema to file",
    builder: {
      "schema-file": {
        alias: "s",
        default: "schema.sql",
        describe: "File that the database schema will be written to",
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
      "migration-table": {
        alias: "t",
        default: "migrations",
        describe: "Database table that tracks previously applied migrations",
      },
    },
    handler: async ({
      schemaFile,
      host,
      port,
      database,
      username,
      password,
      connectionString,
      migrationTable,
    }) => {
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
        await dumpSchemaToFile(client, schemaFile, migrationTable)
      } finally {
        await client.end()
      }
    },
  })

  .demandCommand()

  .fail((msg, err, yargs) => {
    if (err) {
      console.error(err.stack ?? err.message ?? String(err))
    } else {
      console.error(msg)
    }
    console.info(yargs.help())
    process.exit(1)
  })

  .parse()
