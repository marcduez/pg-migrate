import crypto from "crypto"
import fs from "fs"
import mockFs from "mock-fs"
import path from "path"
import type { QueryResult } from "pg"
import { Client } from "pg"
import type { MockInstance } from "vitest"
import {
  createDatabaseMigration,
  databaseNeedsMigration,
  migrateDatabase,
  migrateV2ToV3,
  overwriteDatabaseMd5,
  updateSchemaFile,
} from "."
import { getDatabaseSchema } from "./get-database-schema/get-database-schema"

vi.mock("pg", () => {
  const Client = vi.fn(
    class {
      query = vi.fn()
    },
  )
  return {
    escapeIdentifier: (identifier: string) => `"${identifier}"`,
    escapeLiteral: (literal: string) => `'${literal}'`,
    Client,
  }
})
vi.mock("./get-database-schema/get-database-schema")

const getDigestFromString = (str: string) =>
  crypto
    .createHash("md5")
    .update(new Uint8Array(Buffer.from(str, "utf-8")))
    .digest("hex")

afterEach(() => {
  vi.useRealTimers()
  mockFs.restore()
})

describe("createDatabaseMigration()", () => {
  it("creates file with required arguments set", async () => {
    mockFs({})
    vi.setSystemTime(new Date("2020-01-02T03:04:05Z"))

    const actual = await createDatabaseMigration()

    expect(actual).toBe(
      path.join(process.cwd(), "migrations", "20200102030405.sql"),
    )
  })

  it("creates file with all arguments set", async () => {
    mockFs({})
    vi.setSystemTime(new Date("2020-01-02T03:04:05Z"))

    const actual = await createDatabaseMigration(
      "it's my _new_ migration!",
      path.join(process.cwd(), "migrationDir"),
    )

    expect(actual).toBe(
      path.join(
        process.cwd(),
        "migrationDir",
        "20200102030405_it_s_my_new_migration.sql",
      ),
    )
  })
})

describe("databaseNeedsMigration()", () => {
  it("returns true when database does not contain migration table", async () => {
    mockFs({})

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: false }] } as QueryResult)

    const actual = await databaseNeedsMigration(client)

    expect(actual).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it("returns true when there are migrations that have not been applied to database", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200102030405_unapplied_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<
        () => Promise<QueryResult<{ exists: boolean }>>
      >
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)

    const actual = await databaseNeedsMigration(client)

    expect(actual).toBe(true)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it("warns when migration is in database and not in filesystem", async () => {
    mockFs({})

    const mockWarn = vi.fn<typeof console.warn>()
    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200102030405_applied_migration.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
        ],
      } as QueryResult)

    await databaseNeedsMigration(client, undefined, undefined, {
      debug: () => {},
      warn: mockWarn,
    })

    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockWarn.mock.calls).toStrictEqual([
      [
        "WARNING: Migration 20200102030405_applied_migration.sql has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files",
      ],
    ])
  })

  it("throws when migration in database and filesystem have different digests", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200102030405.sql": "migration1",
        "20200102030406.sql": "migration2",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200102030405.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
          {
            filename: "20200102030406.sql",
            md5: "99836b0f4ca50ed7ed998c0141a334e3",
          },
        ],
      } as QueryResult)

    await expect(databaseNeedsMigration(client)).rejects.toThrow(
      "Migration 20200102030406.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database",
    )

    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it("returns false when database does not need migration with all arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrationDir")]: {
        "20200102030405_first_migration.sql": "migration1",
        "20200102030406_second_migration.sql": "migration2",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200102030405_first_migration.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
          {
            filename: "20200102030406_second_migration.sql",
            md5: "99836b0f4ca50ed7ed998c0141a334e4",
          },
        ],
      } as QueryResult)

    const actual = await databaseNeedsMigration(
      client,
      "migrationDir",
      "migrationTable",
      {
        debug: message => console.debug(message),
        warn: message => console.warn(message),
      },
    )

    expect(actual).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it("returns false when database does not need migration with required arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200102030405.sql": "migration1",
        "20200102030406.sql": "migration2",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200102030405.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
          {
            filename: "20200102030406.sql",
            md5: "99836b0f4ca50ed7ed998c0141a334e4",
          },
        ],
      } as QueryResult)

    const actual = await databaseNeedsMigration(client)

    expect(actual).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})

describe("migrateDatabase()", () => {
  it("creates migration table if it does not exist", async () => {
    mockFs({})

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(client)

    expect(mockQuery).toHaveBeenCalledTimes(5)
    expect(mockQuery.mock.calls[1]).toStrictEqual([
      expect.stringMatching(/^create\stable\s.*/),
    ])
  })

  it("ignores files with invalid names", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "my-file.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(client)

    // If query was only called 5 times, then it ignored the migration file.
    expect(mockQuery).toHaveBeenCalledTimes(5)
    expect(mockQuery.mock.calls).not.toContainEqual(
      expect.arrayContaining([expect.stringMatching(/^insert\sinto\s.*/)]),
    )
  })

  it("warns when migration is in database and not in filesystem", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    const mockWarn = vi.fn<typeof console.warn>()
    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200101000000_applied_migration.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
        ],
      } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(
      client,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        debug: () => {},
        info: () => {},
        warn: mockWarn,
        error: () => {},
      },
    )

    expect(mockQuery).toHaveBeenCalledTimes(5)
    expect(mockWarn.mock.calls).toStrictEqual([
      [
        "WARNING: Migration 20200101000000_applied_migration.sql has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files",
      ],
    ])
  })

  it("throws when migration in database and filesystem have different digests", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
        "20200101000001_second_migration.sql": "migration2",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          {
            filename: "20200101000000_first_migration.sql",
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
          },
          {
            filename: "20200101000001_second_migration.sql",
            md5: "99836b0f4ca50ed7ed998c0141a334e3",
          },
        ],
      } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(migrateDatabase(client)).rejects.toThrow(
      "Migration 20200101000001_second_migration.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database",
    )

    expect(mockQuery).toHaveBeenCalledTimes(5)
  })

  it("applies migration with transaction", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")

    // Generate 101 migrations.
    const files = [...Array.from({ length: 101 })].map<{
      filename: string
      content: string
      digest: string
    }>((_, i) => ({
      filename: `2020010100${i.toString().padStart(4, "0")}.sql`,
      content: `migration${i}`,
      digest: getDigestFromString(`migration${i}`),
    }))

    mockFs({
      [schemaFilePath]: "old-schema",
      [path.join(process.cwd(), "migrations")]: files.reduce(
        (map, { filename, content }) => {
          map[filename] = content
          return map
        },
        {} as Record<string, string>,
      ),
    })

    const mockGetDatabaseSchema = vi
      .mocked(getDatabaseSchema)
      .mockResolvedValueOnce("new-schema")

    let queryCount = 0
    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    ).mockImplementation(async () => {
      ++queryCount
      if (queryCount === 1) {
        // Acquire lock
        return { rows: [{ acquired: true }] } as QueryResult
      }
      if (queryCount === 2) {
        // Create migration table if not exists
        return { rows: [] as unknown[] } as QueryResult
      }
      if (queryCount === 3) {
        // Check migration table exists
        return { rows: [{ exists: true }] } as QueryResult
      }
      if (queryCount === 4) {
        // Select existing digests
        return { rows: [] as unknown[] } as QueryResult
      }
      if (queryCount < 101 * 4 + 4) {
        // 4 queries per migration:
        // - Begin transaction
        // - Apply migration
        // - Insert migration row
        // - Commit
        return { rows: [] as unknown[] } as QueryResult
      }
      // Release lock
      return { rows: [{ released: true }] } as QueryResult
    })

    await migrateDatabase(client)

    expect(mockQuery).toHaveBeenCalledTimes(409)
    expect(mockGetDatabaseSchema.mock.calls).toStrictEqual([[client]])
    expect(fs.readFileSync(schemaFilePath, "utf-8")).toBe("new-schema")
  })

  it("applies migration without transaction", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")
    const migration = "-- no_transaction\nmigration1"

    mockFs({
      [schemaFilePath]: "old-schema",
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000.sql": migration,
      },
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("new-schema")

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Apply migration
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration row
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(client)

    expect(mockQuery).toHaveBeenCalledTimes(7)
  })

  it("updates statement_timeout when value is provided", async () => {
    mockFs({
      [path.join(process.cwd(), "schema.sql")]: "old-schema",
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("new-schema")

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Select statement timeout
      .mockResolvedValueOnce({
        rows: [{ statement_timeout: "0" }],
      } as QueryResult)
      // Update statement timeout
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Begin transaction
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Apply migration
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration row
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Commit transaction
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)
      // Update statement timeout
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)

    await migrateDatabase(
      client,
      undefined,
      undefined,
      undefined,
      undefined,
      300,
    )

    expect(mockQuery).toHaveBeenCalledTimes(12)
    expect(mockQuery.mock.calls[0]).toStrictEqual(["show statement_timeout;"])
    expect(mockQuery.mock.calls[1]).toStrictEqual([
      "set statement_timeout = $1;",
      ["300s"],
    ])
    expect(mockQuery.mock.calls[11]).toStrictEqual([
      "set statement_timeout = $1;",
      ["0"],
    ])
  })

  it("throws when throwOnChangedSchema=true and schema is changed by migration", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")
    const migration = "migration1"

    mockFs({
      [schemaFilePath]: "old-schema",
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000.sql": migration,
      },
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("new-schema")

    const client = new Client()
    ;(vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Apply migration
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration row
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(
      migrateDatabase(client, undefined, undefined, undefined, true),
    ).rejects.toThrow("Database schema was unexpectedly changed by migrations!")
  })

  it("does not throw when throwOnChangedSchema=true and schema is not changed by migration", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")
    const migration = "migration1"

    mockFs({
      [schemaFilePath]: "old-schema",
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000.sql": migration,
      },
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("old-schema")

    const client = new Client()
    ;(vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Create migration table if not exists
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Apply migration
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration row
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(
      migrateDatabase(client, undefined, undefined, undefined, true),
    ).resolves.not.toThrow()
  })
})

describe("migrateV2ToV3", () => {
  it("throws if migration directory does not exist", async () => {
    mockFs({})

    await expect(migrateV2ToV3(new Client())).rejects.toThrow(
      /^The directory .* does not exist$/,
    )
  })

  it("throws if migration table does not exist", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: false }] } as QueryResult)

    await expect(migrateV2ToV3(client)).rejects.toThrow(
      "The migration table migrations does not exist",
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it("drops and recreates migration table, renames files, and writes pg_migrate_v2_to_v3_migration.sql", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
        "0003.sql": "migration3",
      },
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("new-schema")

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Begin transaction
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Select existing migrations
      .mockResolvedValueOnce({
        rows: [
          {
            version: 1,
            md5: "7efb2a07775469cb63c3b4b2d8302e8e",
            applied_at: "2020-01-02T03:04:05Z",
          },
          {
            version: 2,
            md5: "99836b0f4ca50ed7ed998c0141a334e4",
            applied_at: "2020-02-03T04:05:06Z",
          },
          {
            version: 3,
            md5: "855c86c7fb7b67c95e7de5a0a8b63b84",
            applied_at: "2020-03-04T05:06:07Z",
          },
        ],
      } as QueryResult)
      // Drop migrations table
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Create migrations table
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration 1
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration 2
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Insert migration 3
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Commit transaction
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateV2ToV3(client)

    const actualFilenames = (
      await fs.promises.readdir(path.join(process.cwd(), "migrations"))
    ).sort()
    const actualV2ToV3MigrationScript = await fs.promises.readFile(
      path.join(process.cwd(), "pg_migrate_v2_to_v3_migration.sql"),
      "utf-8",
    )

    expect(mockQuery).toHaveBeenCalledTimes(11)
    expect(mockQuery.mock.calls[3]).toStrictEqual([
      "select version, md5, to_json(applied_at_utc at time zone 'UTC') as applied_at from public.\"migrations\" order by version;",
    ])
    expect(mockQuery.mock.calls[4]).toStrictEqual([
      'drop table if exists public."migrations";',
    ])
    expect(mockQuery.mock.calls[6]).toStrictEqual([
      "insert into public.\"migrations\" (filename, md5, applied_at_utc) values ('20200102030405.sql', '7efb2a07775469cb63c3b4b2d8302e8e', '2020-01-02T03:04:05.000Z');",
    ])
    expect(mockQuery.mock.calls[7]).toStrictEqual([
      "insert into public.\"migrations\" (filename, md5, applied_at_utc) values ('20200203040506.sql', '99836b0f4ca50ed7ed998c0141a334e4', '2020-02-03T04:05:06.000Z');",
    ])
    expect(mockQuery.mock.calls[8]).toStrictEqual([
      "insert into public.\"migrations\" (filename, md5, applied_at_utc) values ('20200304050607.sql', '855c86c7fb7b67c95e7de5a0a8b63b84', '2020-03-04T05:06:07.000Z');",
    ])
    expect(actualFilenames).toStrictEqual([
      "20200102030405.sql",
      "20200203040506.sql",
      "20200304050607.sql",
    ])
    expect(actualV2ToV3MigrationScript).toStrictEqual(`begin transaction;
drop table if exists public."migrations";
create table if not exists public."migrations" (filename text collate "C" not null primary key, md5 char(32) not null, applied_at_utc timestamp not null default (now() at time zone 'UTC'));
insert into public."migrations" (filename, md5, applied_at_utc) values ('20200102030405.sql', '7efb2a07775469cb63c3b4b2d8302e8e', '2020-01-02T03:04:05.000Z');
insert into public."migrations" (filename, md5, applied_at_utc) values ('20200203040506.sql', '99836b0f4ca50ed7ed998c0141a334e4', '2020-02-03T04:05:06.000Z');
insert into public."migrations" (filename, md5, applied_at_utc) values ('20200304050607.sql', '855c86c7fb7b67c95e7de5a0a8b63b84', '2020-03-04T05:06:07.000Z');
commit;`)
    expect(fs.readFileSync(schemaFilePath, "utf-8")).toBe("new-schema")
  })
})

describe("overwriteDatabaseMd5()", () => {
  it("throws when migration file does not exist", async () => {
    mockFs({})

    await expect(
      overwriteDatabaseMd5(new Client(), "path/to/migration-file.sql"),
    ).rejects.toThrow(/^The file .* does not exist$/)
  })

  it("throws when migration table does not exist", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: false }] } as QueryResult)

    await expect(
      overwriteDatabaseMd5(
        client,
        path.join(
          process.cwd(),
          "migrations",
          "20200101000000_first_migration.sql",
        ),
      ),
    ).rejects.toThrow("The migration table migrations does not exist")

    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it("throws when migration row is not in table", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Acquire lock
      .mockResolvedValueOnce({
        rows: [{ acquired: true }],
        rowCount: 0,
      } as QueryResult)
      // Select existing digest
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(
      overwriteDatabaseMd5(
        client,
        path.join(
          process.cwd(),
          "migrations",
          "20200101000000_first_migration.sql",
        ),
      ),
    ).rejects.toThrow(
      "No migration with filename 20200101000000_first_migration.sql exists in the database, cannot overwrite MD5 digest",
    )

    expect(mockQuery).toHaveBeenCalledTimes(4)
  })

  it("updates database md5 to match file md5", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Select existing digest
      .mockResolvedValueOnce({
        rows: [{ md5: "7efb2a07775469cb63c3b4b2d8302e8f" }],
      } as QueryResult)
      // Update md5
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await overwriteDatabaseMd5(
      client,
      path.join(
        process.cwd(),
        "migrations",
        "20200101000000_first_migration.sql",
      ),
    )

    expect(mockQuery).toHaveBeenCalledTimes(5)
    expect(mockQuery.mock.calls[3]).toStrictEqual([
      `update public."migrations" set
        md5 = $2
      where
        filename = $1`,
      [
        "20200101000000_first_migration.sql",
        "7efb2a07775469cb63c3b4b2d8302e8e",
      ],
    ])
  })

  it("does not update database md5 when digests already match", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000_first_migration.sql": "migration1",
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Select existing digest
      .mockResolvedValueOnce({
        rows: [{ md5: "7efb2a07775469cb63c3b4b2d8302e8e" }],
      } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await overwriteDatabaseMd5(
      client,
      path.join(
        process.cwd(),
        "migrations",
        "20200101000000_first_migration.sql",
      ),
    )

    // If it was called 4 times, then no update command was sent.
    expect(mockQuery).toHaveBeenCalledTimes(4)
  })
})

describe("updateSchemaFile()", () => {
  it("updates schema file with current database schema", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")

    mockFs({
      [schemaFilePath]: "old-schema",
    })

    const mockGetDatabaseSchema = vi
      .mocked(getDatabaseSchema)
      .mockResolvedValueOnce("new-schema")

    const client = new Client()

    await updateSchemaFile(schemaFilePath, client)

    expect(mockGetDatabaseSchema.mock.calls).toStrictEqual([[client]])
    expect(fs.readFileSync(schemaFilePath, "utf-8")).toBe("new-schema")
  })

  it("throws when throwOnChangedSchema=true and schema is changed by migration", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")

    mockFs({
      [schemaFilePath]: "old-schema",
    })

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("new-schema")

    const client = new Client()

    await expect(
      updateSchemaFile(schemaFilePath, client, true),
    ).rejects.toThrow("Database schema was unexpectedly changed by migrations!")
  })

  it("does not throw when throwOnChangedSchema=true and schema is not changed by migration", async () => {
    const schemaFilePath = path.join(process.cwd(), "schema.sql")

    mockFs({
      [schemaFilePath]: "old-schema",
    })

    const mockInfo = vi.fn<typeof console.warn>()

    vi.mocked(getDatabaseSchema).mockResolvedValueOnce("old-schema")

    const client = new Client()

    await expect(
      updateSchemaFile(schemaFilePath, client, false, {
        info: mockInfo,
      }),
    ).resolves.not.toThrow()
    expect(mockInfo).toHaveBeenCalledWith(
      "Not updating schema file - no changes detected",
    )
  })

  it("logs and exits when schema path is falsy", async () => {
    const mockInfo = vi.fn<typeof console.warn>()

    const client = new Client()

    await updateSchemaFile("", client, undefined, {
      info: mockInfo,
    })

    expect(mockInfo.mock.calls).toStrictEqual([
      ["Not updating schema file - no path was provided"],
    ])
    expect(vi.mocked(getDatabaseSchema)).not.toHaveBeenCalled()
  })
})
