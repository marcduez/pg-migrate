import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Client, ClientBase, escapeIdentifier, escapeLiteral } from "pg"
import readline from "readline"
import { dumpSchema } from "./dump-schema/dump-schema"

const MIGRATION_DIR = path.join(process.cwd(), "migrations")
const MIGRATION_LOCK_ID1 = 1477123592
const MIGRATION_LOCK_ID2 = 1012360337
const MIGRATION_TABLE_NAME = "migrations"
const MIGRATION_FILE_PATTERN = /^\d{14}(_.*)?\.sql$/i
const SCHEMA_FILE = "schema.sql"
// The time to wait between each attempt to acquire a database lock.
const ACQUIRE_LOCK_BACK_OFFS_MS = [200, 500, 1000]

const migrationTableExists = async (client: ClientBase, tableName: string) =>
  (
    await client.query<{ exists: boolean }>(
      `select exists (
        select
        from information_schema.tables
        where table_schema = 'public'
        and table_name = $1
      );`,
      [tableName],
    )
  ).rows[0].exists

const createMigrationTableIfNotExists = async (
  client: ClientBase,
  tableName: string,
) => {
  const escapedTableName = escapeIdentifier(tableName)
  const command = `create table if not exists public.${escapedTableName} (
    filename text collate "C" not null primary key
    , md5 char(32) not null
    , applied_at_utc timestamp not null default (now() at time zone 'UTC')
  );`
  await client.query(command)
  return command
}

const dropMigrationTableIfExists = async (
  client: ClientBase,
  tableName: string,
) => {
  const escapedTableName = escapeIdentifier(tableName)
  const command = `drop table if exists public.${escapedTableName};`
  await client.query(command)
  return command
}

const getDigestsFromDatabase = async (
  client: ClientBase,
  tableName: string,
) => {
  if (!(await migrationTableExists(client, tableName))) {
    return new Map<string, string>()
  }
  const escapedTableName = escapeIdentifier(tableName)
  const command = `select filename, md5 from public.${escapedTableName} order by filename;`
  return new Map<string, string>(
    (await client.query<{ filename: string; md5: string }>(command)).rows.map(
      row => [row.filename, row.md5],
    ),
  )
}

const getDigestFromFile = async (filePath: string) => {
  const hash = crypto.createHash("md5").setEncoding("hex")
  const readStream = fs.createReadStream(filePath)
  return new Promise<string>((resolve, reject) => {
    readStream
      .on("end", () => {
        hash.end()
        resolve(hash.read())
      })
      .on("error", reject)
      .pipe(hash)
  })
}

const getDigestFromString = (content: string) =>
  crypto.createHash("md5").update(content).digest("hex")

const getDigestsFromFiles = async (
  dir: string,
  log: { debug: (message: unknown) => void },
) => {
  if (!fs.existsSync(dir)) {
    return new Map<string, string>()
  }

  const filenames = (await fs.promises.readdir(dir)).sort()
  const digestsByFilename = new Map<string, string>()
  for (const filename of filenames) {
    if (!MIGRATION_FILE_PATTERN.test(filename)) {
      log.debug(`Skipping non-migration file: ${filename}`)
      continue
    }
    const digest = await getDigestFromFile(path.join(dir, filename))
    digestsByFilename.set(filename, digest)
  }
  return digestsByFilename
}

const shouldCreateTransactionForFile = async (filePath: string) => {
  const readStream = fs.createReadStream(filePath)
  try {
    const lineReader = readline.createInterface({ input: readStream })
    return await new Promise<boolean>(resolve => {
      let result = true
      lineReader
        .on("line", line => {
          result = line.trim() !== "-- no_transaction"
          lineReader.close()
        })
        .on("close", () => {
          resolve(result)
        })
    })
  } finally {
    readStream.close()
  }
}

const insertMigration = async (
  client: ClientBase,
  tableName: string,
  filename: string,
  md5: string,
  appliedAtUtc?: Date,
) => {
  const escapedTableName = escapeIdentifier(tableName)
  const escapedFilename = escapeLiteral(filename)
  const escapedMd5 = escapeLiteral(md5)
  const escapedAppliedAtUtc = appliedAtUtc
    ? escapeLiteral(appliedAtUtc.toISOString())
    : "default"
  const command = `insert into public.${escapedTableName} (filename, md5, applied_at_utc) values (${escapedFilename}, ${escapedMd5}, ${escapedAppliedAtUtc});`
  await client.query(command)
  return command
}

const acquireLock = async (client: ClientBase): Promise<void> => {
  let retryIndex = 0
  do {
    const {
      rows: [acquired],
    } = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock($1, $2) as acquired;`,
      [MIGRATION_LOCK_ID1, MIGRATION_LOCK_ID2],
    )
    if (acquired) {
      return
    }
    await new Promise(resolve => {
      const randomMs = Math.floor(Math.random() * 100) - 50
      setTimeout(resolve, ACQUIRE_LOCK_BACK_OFFS_MS[retryIndex] + randomMs)
    })
  } while (++retryIndex < ACQUIRE_LOCK_BACK_OFFS_MS.length)

  throw new Error("Could not acquire lock")
}

const releaseLock = async (client: ClientBase): Promise<void> => {
  const {
    rows: [released],
  } = await client.query<{ released: boolean }>(
    `select pg_advisory_unlock($1, $2) as released;`,
    [MIGRATION_LOCK_ID1, MIGRATION_LOCK_ID2],
  )

  if (!released) {
    throw new Error("Could not release lock")
  }
}

const warnIfDigestsInDatabaseButNotInFiles = (
  digestsFromDatabase: Map<string, string>,
  digestsFromFiles: Map<string, string>,
  log = {
    warn: (message: unknown) => console.warn(message),
  },
) => {
  for (const [filename, digestFromDatabase] of digestsFromDatabase) {
    if (!digestsFromFiles.has(filename)) {
      log.warn(
        `WARNING: Migration ${filename} has digest ${digestFromDatabase} in database, and does not exist in files`,
      )
    }
  }
}

const throwIfDigestsDiffer = (
  digestsFromDatabase: Map<string, string>,
  digestsFromFiles: Map<string, string>,
) => {
  for (const [filename, digestFromDatabase] of digestsFromDatabase) {
    const digestFromFile = digestsFromFiles.get(filename)
    if (digestFromFile && digestFromFile !== digestFromDatabase) {
      throw new Error(
        `Migration ${filename} has digest ${digestFromFile} in files, and digest ${digestFromDatabase} in database`,
      )
    }
  }
}

const normalizeMigrationName = (name: string) =>
  name
    .toLowerCase()
    // Replace any non-alphanumeric, non-underscore character with an underscore.
    .replace(/[^_a-z0-9]+/g, "_")
    // Replace any sequence of 2 or more underscores with a single underscore.
    .replace(/_{2,}/g, "_")
    // Replace leading or trailing underscores with empty strings.
    .replace(/^_+|_+$/g, "")

const getTimestampString = (instant = new Date()) => {
  const year = instant.getUTCFullYear()
  const month = String(instant.getUTCMonth() + 1).padStart(2, "0")
  const day = String(instant.getUTCDate()).padStart(2, "0")
  const hours = String(instant.getUTCHours()).padStart(2, "0")
  const minutes = String(instant.getUTCMinutes()).padStart(2, "0")
  const seconds = String(instant.getUTCSeconds()).padStart(2, "0")
  return `${year}${month}${day}${hours}${minutes}${seconds}`
}

/**
 * Creates a database migration file.
 *
 * @param migrationName - The name of the migration.
 * @param migrationDir - The migration directory to use.
 * @returns The path of the resulting file.
 */
export const createDatabaseMigration = async (
  migrationName = "",
  migrationDir = MIGRATION_DIR,
) => {
  if (!fs.existsSync(migrationDir)) {
    fs.mkdirSync(migrationDir, { recursive: true })
  }

  const currentTimestamp = getTimestampString()
  let normalizedName = normalizeMigrationName(migrationName)
  if (normalizedName) {
    normalizedName = `_${normalizedName}`
  }
  const filename = `${currentTimestamp}${normalizedName}.sql`
  const filePath = path.join(migrationDir, filename)
  await fs.promises.writeFile(filePath, "", "utf8")
  return filePath
}

/**
 * Returns true if there are un-applied database migrations.
 *
 * @param client - The database client to use.
 * @param migrationDir - The migration directory to use.
 * @param migrationTableName - The migration table name to use.
 * @returns True if the un-applied database migrations.
 */
export const databaseNeedsMigration = async (
  client: ClientBase,
  migrationDir = MIGRATION_DIR,
  migrationTableName = MIGRATION_TABLE_NAME,
  log = {
    debug: (message: unknown) => console.debug(message),
    warn: (message: unknown) => console.warn(message),
  },
) => {
  const digestsFromDatabase = await getDigestsFromDatabase(
    client,
    migrationTableName,
  )
  const digestsFromFiles = await getDigestsFromFiles(migrationDir, log)

  warnIfDigestsInDatabaseButNotInFiles(
    digestsFromDatabase,
    digestsFromFiles,
    log,
  )

  throwIfDigestsDiffer(digestsFromDatabase, digestsFromFiles)

  return [...digestsFromFiles.keys()].some(key => !digestsFromDatabase.has(key))
}

/**
 * Applies any pending database migrations.
 *
 * @param client - The database client to use.
 * @param migrationDir - The migration directory to use.
 * @param migrationTableName - The migration table name to use.
 * @param schemaFile - The path to the file to write the database schema to after applying the migrations. Set to empty string to skip writing the database schema to file.
 * @param throwOnChangedSchema - Whether to throw an error if the current database schema differs from the schema in the schema file.
 * @param statementTimeoutSeconds - The number of seconds to set for statement_timeout when applying the migrations. If not set, the existing statement_timeout is not modified.
 * @param log - The logger to use.
 */
export const migrateDatabase = async (
  client: Client,
  migrationDir = MIGRATION_DIR,
  migrationTableName = MIGRATION_TABLE_NAME,
  schemaFile = SCHEMA_FILE,
  throwOnChangedSchema = false,
  statementTimeoutSeconds?: number,
  log = {
    debug: (message: unknown) => console.debug(message),
    info: (message: unknown) => console.log(message),
    warn: (message: unknown) => console.warn(message),
    error: (message: unknown) => console.error(message),
  },
) => {
  // If statementTimeoutSeconds is defined, set aside the current statement_timeout and set a new one.
  let currentStatementTimeout: string | null = null
  if (statementTimeoutSeconds !== undefined) {
    currentStatementTimeout = (
      await client.query<{ statement_timeout: string }>(
        "show statement_timeout;",
      )
    ).rows[0].statement_timeout
    await client.query("set statement_timeout = $1;", [
      `${statementTimeoutSeconds}s`,
    ])
  }

  await acquireLock(client)
  try {
    await createMigrationTableIfNotExists(client, migrationTableName)

    const digestsFromDatabase = await getDigestsFromDatabase(
      client,
      migrationTableName,
    )
    const digestsFromFiles = await getDigestsFromFiles(migrationDir, log)

    warnIfDigestsInDatabaseButNotInFiles(
      digestsFromDatabase,
      digestsFromFiles,
      log,
    )

    throwIfDigestsDiffer(digestsFromDatabase, digestsFromFiles)

    const filenamesToMigrate = [...digestsFromFiles.keys()]
      .filter(filename => !digestsFromDatabase.has(filename))
      .sort()

    log.info(
      filenamesToMigrate.length === 1
        ? "There is 1 database migration to apply"
        : `There are ${filenamesToMigrate.length} database migrations to apply`,
    )
    if (!filenamesToMigrate.length) {
      return
    }

    for (const filename of filenamesToMigrate) {
      const digest = digestsFromFiles.get(filename)!
      log.info(`Applying migration ${filename}...`)

      const filePath = path.join(migrationDir, filename)
      const inTransaction = await shouldCreateTransactionForFile(filePath)

      if (inTransaction) {
        await client.query("begin transaction;")
      } else {
        log.info(`Skipping transaction for ${filename}`)
      }
      try {
        const migrationSql = (
          await fs.promises.readFile(filePath, "utf8")
        ).trim()
        if (!migrationSql) {
          throw new Error(`File ${filename} is empty`)
        }
        await client.query(migrationSql)
        await insertMigration(client, migrationTableName, filename, digest)

        if (inTransaction) {
          await client.query("commit;")
        }

        log.info(`Applied migration`)
      } catch (migrationError) {
        if (inTransaction) {
          try {
            await client.query("rollback;")
          } catch (rollbackError) {
            log.error(rollbackError)
          }
        }
        throw migrationError
      }
    }

    // Write the new database schema to file
    await dumpSchemaToFile(client, schemaFile, throwOnChangedSchema, log)
  } finally {
    try {
      await releaseLock(client)
    } catch (e) {
      log.error(e)
    }
  }

  // If we set aside a statement_timeout, restore it.
  if (currentStatementTimeout !== null) {
    await client.query("set statement_timeout = $1;", [currentStatementTimeout])
  }
}

/**
 * Performs the tasks required to migrate from v2 to v3 of pg-migrate:
 * - recreates the migration table with the new schema
 * - renames all existing migration files to have a timestamp-based filename instead of a version-based filename
 * - updates the database schema file
 */
export const migrateV2ToV3 = async (
  client: Client,
  migrationDir = MIGRATION_DIR,
  migrationTableName = MIGRATION_TABLE_NAME,
  schemaFile = SCHEMA_FILE,
  log = {
    debug: (message: unknown) => console.debug(message),
    info: (message: unknown) => console.log(message),
    error: (message: unknown) => console.error(message),
  },
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  if (!(await migrationTableExists(client, migrationTableName))) {
    throw new Error(`The migration table ${migrationTableName} does not exist`)
  }

  const scriptLines: string[] = []

  await acquireLock(client)
  try {
    const beginTransactionCommand = "begin transaction;"
    await client.query(beginTransactionCommand)
    scriptLines.push(beginTransactionCommand)

    try {
      const newFilenames = new Set<string>()
      const newMigrationFilenamesByOldFilename = new Map<string, string>()

      // Read all existing migration rows from database
      const escapedMigrationTableName = escapeIdentifier(migrationTableName)
      const { rows: existingMigrationRows } = await client.query<{
        version: number
        md5: string
        applied_at: string
      }>(
        `select version, md5, to_json(applied_at_utc at time zone 'UTC') as applied_at from public.${escapedMigrationTableName} order by version;`,
      )

      console.log("Dropping and recreating migration table...")

      // Drop existing migration table
      scriptLines.push(
        await dropMigrationTableIfExists(client, migrationTableName),
      )

      // Create new migration table
      scriptLines.push(
        await createMigrationTableIfNotExists(client, migrationTableName),
      )

      // For each existing migration row, insert a row in the new table, and set aside a mapping from the old filename to the new filename
      for (const row of existingMigrationRows) {
        const appliedAt = new Date(row.applied_at)
        const oldFilename = `${row.version.toString().padStart(4, "0")}.sql`
        // If migration filenames collide, increment the timestamp by 1 second until they don't.
        let newFilenameTimestamp = appliedAt
        let newFilename = `${getTimestampString(newFilenameTimestamp)}.sql`
        while (newFilenames.has(newFilename)) {
          newFilenameTimestamp = new Date(newFilenameTimestamp.getTime() + 1000)
          newFilename = `${getTimestampString(newFilenameTimestamp)}.sql`
        }
        newFilenames.add(newFilename)
        newMigrationFilenamesByOldFilename.set(oldFilename, newFilename)

        scriptLines.push(
          await insertMigration(
            client,
            migrationTableName,
            newFilename,
            row.md5,
            appliedAt,
          ),
        )
      }

      console.log("Recreated migration table")

      console.log("Renaming migration files...")

      // For every old-filename-to-new-filename mapping, rename the migration file on disk
      for (const [
        oldFilename,
        newFilename,
      ] of newMigrationFilenamesByOldFilename) {
        fs.renameSync(
          path.join(migrationDir, oldFilename),
          path.join(migrationDir, newFilename),
        )
      }

      console.log("Renamed migration files")

      // Commit the changes to the database
      const commitTransactionCommand = "commit;"
      await client.query(commitTransactionCommand)
      scriptLines.push(commitTransactionCommand)

      // Write the new database schema to file
      await dumpSchemaToFile(client, schemaFile, undefined, log)

      // Write script to migration migration table to file.
      fs.writeFileSync(
        path.join(process.cwd(), "pg_migrate_v2_to_v3_migration.sql"),
        scriptLines.map(command => command.replace(/\n\s+/g, "")).join("\n"),
        // scriptLines.join("\n"),
        "utf-8",
      )
    } catch (transactionError) {
      try {
        await client.query("rollback")
      } catch (rollbackError) {
        log.error(rollbackError)
      }
      throw transactionError
    }
  } finally {
    try {
      await releaseLock(client)
    } catch (e) {
      log.error(e)
    }
  }
}

/**
 * Overwrites the MD5 digest of a migration in a database with the MD5 digest from the migration file.
 */
export const overwriteDatabaseMd5 = async (
  client: ClientBase,
  migrationFilePath: string,
  migrationTableName = MIGRATION_TABLE_NAME,
  log = {
    error: (message: unknown) => console.error(message),
  },
) => {
  if (!fs.existsSync(migrationFilePath)) {
    throw new Error(`The file ${migrationFilePath} does not exist`)
  }

  if (!(await migrationTableExists(client, migrationTableName))) {
    throw new Error(`The migration table ${migrationTableName} does not exist`)
  }

  await acquireLock(client)
  try {
    const migrationFilename = path.basename(migrationFilePath)
    const digest = await getDigestFromFile(migrationFilePath)
    const escapedMigrationTableName = escapeIdentifier(migrationTableName)

    const existingDigest = await client.query<{ md5: string }>(
      `select md5 from public.${escapedMigrationTableName} where filename = $1;`,
      [migrationFilename],
    )

    if (!existingDigest.rows.length) {
      throw new Error(
        `No migration with filename ${migrationFilename} exists in the database, cannot overwrite MD5 digest`,
      )
    }

    if (existingDigest.rows[0].md5 === digest) {
      console.log(
        `The migration ${migrationFilename} already has the same MD5 digest in the database as the migration file, no need to overwrite`,
      )
      return
    }

    await client.query(
      `update public.${escapedMigrationTableName} set
        md5 = $2
      where
        filename = $1`,
      [migrationFilename, digest],
    )

    console.log(
      `Updated MD5 digest for migration ${migrationFilename} in database - was ${existingDigest.rows[0].md5}, is now ${digest}`,
    )
  } finally {
    try {
      await releaseLock(client)
    } catch (e) {
      log.error(e)
    }
  }
}

/**
 * Dumps the current database schema to file. If throwOnChangedSchema is true, throws an error if the schema file contents change.
 *
 * @param client - The database client to use.
 * @param schemaFile - The path to the file to dump the database schema to.
 * @param throwOnChangedSchema - Whether to throw an error if the schema file contents change.
 * @param log - The logger to use.
 */
export const dumpSchemaToFile = async (
  client: Client,
  schemaFile = SCHEMA_FILE,
  throwOnChangedSchema = false,
  log = { info: (message: unknown) => console.log(message) },
) => {
  if (!schemaFile) {
    log.info(`Not updating schema file - no path was provided`)
    return
  }

  log.info(`Updating schema file ${schemaFile}...`)
  const schemaDigestBefore = fs.existsSync(schemaFile)
    ? await getDigestFromFile(schemaFile)
    : ""
  const schema = await dumpSchema(client)
  const schemaDigestAfter = getDigestFromString(schema)
  if (schemaDigestBefore === schemaDigestAfter) {
    log.info("Not updating schema file - no changes detected")
  } else {
    if (throwOnChangedSchema) {
      throw new Error("Database schema was unexpectedly changed by migrations!")
    }
    await fs.promises.writeFile(schemaFile, schema, "utf8")
    log.info("Updated schema file")
  }
}
