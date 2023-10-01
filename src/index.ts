/* eslint-disable no-console */
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { ClientBase } from "pg"
import readline from "readline"

const MIGRATION_DIR = path.join(process.cwd(), "migrations")
const MIGRATION_LOCK_ID1 = 1477123592
const MIGRATION_LOCK_ID2 = 1012360337
const MIGRATION_TABLE_NAME = "migrations"
const MIGRATION_FILE_PATTERN = /^\d{4}\.sql$/i

const migrationTableExists = async (client: ClientBase, tableName: string) =>
  (
    await client.query<{ exists: boolean }>(
      `select exists (
        select
        from information_schema.tables
        where table_schema = 'public'
        and table_name = $1
      )`,
      [tableName],
    )
  ).rows[0].exists

const createMigrationTable = async (client: ClientBase, tableName: string) =>
  client.query(
    `create table public.${tableName} (
      version int not null primary key
      , md5 char(32) not null
      , applied_at_utc timestamp not null default (now() at time zone 'UTC')
    )`,
  )

const getDigestsFromDatabase = async (client: ClientBase, tableName: string) =>
  new Map<number, string>(
    (
      await client.query<{ version: number; md5: string }>(
        `select version, md5 from ${tableName}`,
      )
    ).rows.map(row => [row.version, row.md5]),
  )

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

const getDigestsFromFiles = async (
  dir: string,
  log: { debug: (message: any) => void },
) => {
  const filenames = await fs.promises.readdir(dir)
  const map = new Map<number, string>()
  for (const filename of filenames) {
    if (!MIGRATION_FILE_PATTERN.test(filename)) {
      log.debug(`Skipping non-migration file: ${filename}`)
      continue
    }
    const version = parseInt(filename.slice(0, 4), 10)
    const digest = await getDigestFromFile(path.join(dir, filename))
    map.set(version, digest)
  }
  return map
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
  version: number,
  md5: string,
) => {
  await client.query(
    `insert into ${tableName} (version, md5) values ($1, $2)`,
    [version, md5],
  )
}

const acquireLock = async (client: ClientBase): Promise<void> => {
  if (
    !(
      await client.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock($1, $2) as acquired`,
        [MIGRATION_LOCK_ID1, MIGRATION_LOCK_ID2],
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
        `select pg_advisory_unlock($1, $2) as released`,
        [MIGRATION_LOCK_ID1, MIGRATION_LOCK_ID2],
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
        Number.NEGATIVE_INFINITY,
      ),
  )

const throwIfDigestsDiffer = (
  digestsFromDatabase: Map<number, string>,
  digestsFromFiles: Map<number, string>,
) => {
  // Check if any previously applied migrations no longer match files.
  const unequalDigestEntry = [...digestsFromDatabase.entries()].find(
    ([key, value]) => digestsFromFiles.get(key) !== value,
  )
  if (unequalDigestEntry) {
    const [version, databaseDigest] = unequalDigestEntry
    const filename = `${version.toString().padStart(4, "0")}.sql`
    const fileDigest = digestsFromFiles.get(version)
    throw new Error(
      fileDigest
        ? `Migration ${filename} has digest ${fileDigest} in files, and digest ${databaseDigest} in database`
        : `Migration ${version} has digest ${databaseDigest} in database, and does not exist in files`,
    )
  }
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
  migrationTableName = MIGRATION_TABLE_NAME,
  log = {
    debug: (message: any) => console.debug(message),
  },
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  if (!(await migrationTableExists(client, migrationTableName))) {
    return true
  }

  const digestsFromDatabase = await getDigestsFromDatabase(
    client,
    migrationTableName,
  )
  const digestsFromFiles = await getDigestsFromFiles(migrationDir, log)

  throwIfDigestsDiffer(digestsFromDatabase, digestsFromFiles)

  return [...digestsFromFiles.keys()].some(key => !digestsFromDatabase.has(key))
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
  migrationTableName = MIGRATION_TABLE_NAME,
  log = {
    debug: (message: any) => console.debug(message),
    info: (message: any) => console.log(message),
    error: (message: any) => console.error(message),
  },
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  await acquireLock(client)
  try {
    if (!(await migrationTableExists(client, migrationTableName))) {
      await createMigrationTable(client, migrationTableName)
    }

    const digestsFromDatabase = await getDigestsFromDatabase(
      client,
      migrationTableName,
    )
    const digestsFromFiles = await getDigestsFromFiles(migrationDir, log)

    throwIfDigestsDiffer(digestsFromDatabase, digestsFromFiles)

    const versionsToMigrate = [...digestsFromFiles.keys()]
      .filter(key => !digestsFromDatabase.has(key))
      .sort((a, b) => a - b)

    log.info(
      `There are ${versionsToMigrate.length} database migration(s) to apply`,
    )
    if (!versionsToMigrate.length) {
      return
    }

    for (const version of versionsToMigrate) {
      const filename = `${version.toString().padStart(4, "0")}.sql`
      log.info(`Applying migration ${filename}...`)

      const filePath = path.join(migrationDir, filename)
      const inTransaction = await shouldCreateTransactionForFile(filePath)

      if (inTransaction) {
        await client.query("begin transaction")
      } else {
        log.info(`Skipping transaction for ${filename}`)
      }
      try {
        const sql = (await fs.promises.readFile(filePath, "utf8")).trim()
        if (!sql) {
          throw new Error(`File ${filename} is empty`)
        }
        await client.query(sql)
        await insertMigration(
          client,
          migrationTableName,
          version,
          digestsFromFiles.get(version)!,
        )

        if (inTransaction) {
          await client.query("commit")
        }
        log.info(`Applied migration`)
      } catch (migrationError) {
        if (inTransaction) {
          try {
            await client.query("rollback")
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
  await fs.promises.writeFile(filePath, "", "utf8")
  return filePath
}
