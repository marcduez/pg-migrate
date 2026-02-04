import crypto from "crypto"
import fs from "fs"
import path from "path"
import { ClientBase } from "pg"
import readline from "readline"

const MIGRATION_DIR = path.join(process.cwd(), "migrations")
const MIGRATION_LOCK_ID1 = 1477123592
const MIGRATION_LOCK_ID2 = 1012360337
const MIGRATION_TABLE_NAME = "migrations"
const MIGRATION_FILE_PATTERN = /^\d{14}(_.*)?\.sql$/i
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
      )`,
      [tableName],
    )
  ).rows[0].exists

const createMigrationTable = async (client: ClientBase, tableName: string) =>
  await client.query(
    `create table public.${tableName} (
      filename text collate "C" not null primary key
      , md5 char(32) not null
      , applied_at_utc timestamp not null default (now() at time zone 'UTC')
    )`,
  )

const getDigestsFromDatabase = async (client: ClientBase, tableName: string) =>
  new Map<string, string>(
    (
      await client.query<{ filename: string; md5: string }>(
        `select filename, md5 from ${tableName} order by filename`,
      )
    ).rows.map(row => [row.filename, row.md5]),
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
  log: { debug: (message: unknown) => void },
) => {
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
) => {
  await client.query(
    `insert into ${tableName} (filename, md5) values ($1, $2)`,
    [filename, md5],
  )
}

const acquireLock = async (client: ClientBase): Promise<void> => {
  let retryIndex = 0
  do {
    const {
      rows: [acquired],
    } = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock($1, $2) as acquired`,
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
    `select pg_advisory_unlock($1, $2) as released`,
    [MIGRATION_LOCK_ID1, MIGRATION_LOCK_ID2],
  )

  if (!released) {
    throw new Error("Could not release lock")
  }
}

const throwIfDigestsDiffer = (
  digestsFromDatabase: Map<string, string>,
  digestsFromFiles: Map<string, string>,
) => {
  // For each previously applied migration, check:
  // - That a file still exists for it.
  // - That the digest in the file matches the digest in the database.
  for (const [filename, digestFromDatabase] of digestsFromDatabase) {
    const digestFromFile = digestsFromFiles.get(filename)
    if (digestFromFile === digestFromDatabase) {
      continue
    }
    throw new Error(
      digestFromFile
        ? `Migration ${filename} has digest ${digestFromFile} in files, and digest ${digestFromDatabase} in database`
        : `Migration ${filename} has digest ${digestFromDatabase} in database, and does not exist in files`,
    )
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

const getCurrentTimestamp = () => {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  const hours = String(now.getUTCHours()).padStart(2, "0")
  const minutes = String(now.getUTCMinutes()).padStart(2, "0")
  const seconds = String(now.getUTCSeconds()).padStart(2, "0")
  return `${year}${month}${day}${hours}${minutes}${seconds}`
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
    debug: (message: unknown) => console.debug(message),
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
    debug: (message: unknown) => console.debug(message),
    info: (message: unknown) => console.log(message),
    error: (message: unknown) => console.error(message),
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

    const filenamesToMigrate = [...digestsFromFiles.keys()]
      .filter(filename => !digestsFromDatabase.has(filename))
      .sort()

    log.info(
      `There are ${filenamesToMigrate.length} database migration(s) to apply`,
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
        await insertMigration(client, migrationTableName, filename, digest)

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
 * @param migrationName - The name of the migration.
 * @param migrationDir - The migration directory to use.
 * @returns The path of the resulting file.
 */
export const createDatabaseMigration = async (
  migrationName = "",
  migrationDir = MIGRATION_DIR,
) => {
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`The directory ${migrationDir} does not exist`)
  }

  const currentTimestamp = getCurrentTimestamp()
  let normalizedName = normalizeMigrationName(migrationName)
  if (normalizedName) {
    normalizedName = `_${normalizedName}`
  }
  const filename = `${currentTimestamp}${normalizedName}.sql`
  const filePath = path.join(migrationDir, filename)
  await fs.promises.writeFile(filePath, "", "utf8")
  return filePath
}
