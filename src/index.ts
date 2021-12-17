/* eslint-disable no-console */
import crypto from "crypto"
import fs, { promises as fsPromises } from "fs"
import path from "path"
import { ClientBase } from "pg"
import readline from "readline"
import SQL from "sql-template-strings"

const SEED_FILE = path.join(process.cwd(), "dbSeed.sql")
const MIGRATION_DIR = path.join(process.cwd(), "dbMigrations")
const MIGRATION_LOCK_ID = 9013200309969543n
let tableNamesToTruncate: string[] | null = null

const migrationTableExists = async (client: ClientBase, tableName: string) =>
  (
    await client.query<{ exists: boolean }>(SQL`
    SELECT EXISTS (
      SELECT
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
    )`)
  ).rows[0].exists

const createMigrationTable = async (client: ClientBase, tableName: string) => {
  await client.query(
    SQL`
    CREATE TABLE public.`.append(tableName).append(SQL` (
      version SMALLINT NOT NULL PRIMARY KEY,
      md5 CHAR(32) NOT NULL,
      applied_at_utc TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
    )`)
  )
}

const getDigestsFromMigrationTable = async (
  client: ClientBase,
  tableName: string
) =>
  new Map<number, string>(
    (
      await client.query<{ version: number; md5: string }>(
        SQL`SELECT version, md5 FROM `.append(tableName)
      )
    ).rows.map(row => [row.version, row.md5])
  )

const getFileDigest = async (filePath: string) => {
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

const getDigestsFromFiles = async (dir: string) => {
  const filenames = (await fs.promises.readdir(dir)).filter(filename =>
    /^\d{4}\.sql$/i.test(filename)
  )

  const map = new Map<number, string>()
  for (const filename of filenames) {
    map.set(
      parseInt(filename.slice(0, 4), 10),
      await getFileDigest(path.join(dir, filename))
    )
  }
  return map
}

const shouldCreateTransaction = async (filePath: string) => {
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
  version: number,
  md5: string
) => {
  await client.query(
    SQL`INSERT INTO `
      .append(tableName)
      .append(SQL` (version, md5) VALUES (${version}, ${md5})`)
  )
}

const acquireLock = async (client: ClientBase): Promise<void> => {
  if (
    !(
      await client.query<{ acquired: boolean }>(
        SQL`select pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as acquired`
      )
    ).rows[0].acquired
  ) {
    throw new Error("Could not acquire lock")
  }
}

const releaseLock = async (client: ClientBase): Promise<void> => {
  if (
    !(
      await client.query<{ released: boolean }>(
        SQL`select pg_advisory_unlock(${MIGRATION_LOCK_ID}) as released`
      )
    ).rows[0].released
  ) {
    throw new Error("Could not release lock")
  }
}

const getMaxVersionFromFiles = async (dir: string) =>
  Math.max(
    0,
    (await fs.promises.readdir(dir))
      .filter(filename => /^\d{4}\.sql$/i.test(filename))
      .reduce<number>(
        (max, filename) => Math.max(max, parseInt(filename.slice(0, 4), 10)),
        Number.NEGATIVE_INFINITY
      )
  )

const getTableNamesToTruncate = async (
  client: ClientBase,
  migrationTableName: string
) => {
  if (tableNamesToTruncate === null) {
    tableNamesToTruncate = (
      await client.query<{ name: string }>(
        SQL`
      SELECT
        table_name AS name
      FROM
        information_schema.tables
      WHERE table_schema = 'public'
      AND table_name != ${migrationTableName}`
      )
    ).rows.map(row => row.name)
  }
  return tableNamesToTruncate
}

/**
 * Returns true if there are un-applied database migrations.
 * @param client - The database client to use.
 * @param migrationDir - The migration directory to use.
 * @param migrationTableName - The migration table name to use.
 * @returns True if the un-applied database migrations.
 */
export const databaseNeedsMigration = async (
  client: ClientBase,
  migrationDir = MIGRATION_DIR,
  migrationTableName = "migrations"
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  const databaseDigests = (await migrationTableExists(
    client,
    migrationTableName
  ))
    ? await getDigestsFromMigrationTable(client, migrationTableName)
    : new Map<number, string>()
  const fileDigests = await getDigestsFromFiles(migrationDir)

  // Check if any previously applied migrations no longer match files.
  const unequalDigestEntry = [...databaseDigests.entries()].find(
    ([key, value]) => fileDigests.get(key) !== value
  )
  if (unequalDigestEntry) {
    const version = unequalDigestEntry[0]
    const filename = `${version.toString().padStart(4, "0")}.sql`
    const databaseDigest = unequalDigestEntry[1]
    const fileDigest = fileDigests.get(unequalDigestEntry[0])
    throw new Error(
      fileDigests.has(unequalDigestEntry[0])
        ? `Migration ${filename} has digest ${fileDigest} in files, and digest ${databaseDigest} in database`
        : `Migration ${version} has digest ${databaseDigest} in database, and does not exist in files`
    )
  }

  return [...fileDigests.keys()].some(key => !databaseDigests.has(key))
}

/**
 * Applies any pending database migrations.
 * @param client - The database client to use.
 * @param migrationDir - The migration directory to use.
 * @param migrationTableName - The migration table name to use.
 * @param log - The logger to use.
 */
export const migrateDatabase = async (
  client: ClientBase,
  migrationDir = MIGRATION_DIR,
  migrationTableName = "migrations",
  log = {
    info: (message: any) => console.log(message),
    error: (message: any) => console.error(message),
  }
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  if (!(await migrationTableExists(client, migrationTableName))) {
    await createMigrationTable(client, migrationTableName)
  }

  const databaseDigests = await getDigestsFromMigrationTable(
    client,
    migrationTableName
  )
  const fileDigests = await getDigestsFromFiles(migrationDir)

  const missingFileVersion = [...databaseDigests.keys()].find(
    key => !fileDigests.has(key)
  )
  if (missingFileVersion) {
    throw new Error(
      `Migration ${missingFileVersion} is in database, but not in files`
    )
  }

  const unequalDigestEntry = [...fileDigests.entries()].find(
    ([key, value]) =>
      databaseDigests.has(key) && databaseDigests.get(key) !== value
  )
  if (unequalDigestEntry) {
    const version = unequalDigestEntry[0]
    const filename = `${version.toString().padStart(4, "0")}.sql`
    const fileDigest = unequalDigestEntry[1]
    const databaseDigest = databaseDigests.get(unequalDigestEntry[0])
    throw new Error(
      `Migration ${filename} has digest ${fileDigest} in files, and digest ${databaseDigest} in database`
    )
  }

  const versionsToMigrate = [...fileDigests.keys()]
    .filter(key => !databaseDigests.has(key))
    .sort()

  log.info(
    `There are ${versionsToMigrate.length} database migration(s) to apply`
  )
  if (!versionsToMigrate.length) {
    return
  }

  await acquireLock(client)
  try {
    for (const version of versionsToMigrate) {
      const filename = `${version.toString().padStart(4, "0")}.sql`
      log.info(`Applying migration ${filename}...`)

      const filePath = path.join(migrationDir, filename)
      const inTransaction = await shouldCreateTransaction(filePath)

      if (inTransaction) {
        await client.query("BEGIN TRANSACTION")
      } else {
        log.info(`Skipping transaction for ${filename}`)
      }
      try {
        const sql = (await fsPromises.readFile(filePath, "utf8")).trim()
        if (!sql) {
          throw new Error(`File ${filename} is empty`)
        }
        await client.query(sql)
        await insertMigration(
          client,
          migrationTableName,
          version,
          fileDigests.get(version)!
        )

        if (inTransaction) {
          await client.query("COMMIT")
        }
        log.info(`Applied migration`)
      } catch (migrationError) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK")
          } catch (rollbackError) {
            log.error(rollbackError)
          }
        }
        throw migrationError
      }
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
 * Creates a database migration file.
 * @param migrationDir - The migration directory to use.
 * @returns The path of the resulting file.
 */
export const createDatabaseMigration = async (migrationDir = MIGRATION_DIR) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  const maxVersion = await getMaxVersionFromFiles(migrationDir)
  const filename = `${(maxVersion + 1).toString().padStart(4, "0")}.sql`
  const filePath = path.join(migrationDir, filename)
  await fsPromises.writeFile(filePath, "")
  return filePath
}

/**
 * Seeds the database with the commands in a SQL file.
 * @param client - The database client to use.
 * @param seedFile - The path to the seed file.
 * @param log - The logger to use.
 */
export const seedDatabase = async (
  client: ClientBase,
  seedFile = SEED_FILE,
  log = {
    debug: (message: any) => console.debug(message),
    error: (message: any) => console.error(message),
  }
) => {
  log.debug("Inserting seed data...")
  await client.query("BEGIN TRANSACTION")
  try {
    const sql = (await fsPromises.readFile(seedFile, "utf8")).trim()
    if (!sql) {
      throw new Error(`File ${seedFile} is empty`)
    }
    await client.query(sql)

    await client.query("COMMIT")
    log.debug("Seed data inserted")
  } catch (seedError) {
    try {
      await client.query("ROLLBACK")
    } catch (rollbackError) {
      log.error(rollbackError)
    }
    throw seedError
  }
}

/**
 * Truncates all tables except the migrations table.
 * @param client - The database client to use.
 * @param migrationTableName - The migration table name to use.
 * @param log - The logger to use.
 */
export const truncateDatabaseTables = async (
  client: ClientBase,
  migrationTableName = "migrations",
  seedFile = SEED_FILE,
  log = {
    debug: (message: any) => console.debug(message),
    error: (message: any) => console.error(message),
  }
) => {
  log.debug("Truncating tables...")
  const tableNames = await getTableNamesToTruncate(client, migrationTableName)
  if (tableNames.length) {
    await client.query(`truncate ${tableNames.join(",")}`)
  }
  log.debug("Tables truncated")
  if (fs.existsSync(seedFile)) {
    await seedDatabase(client, seedFile, log)
  }
}
