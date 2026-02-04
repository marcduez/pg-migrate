import type { MockInstance } from "vitest"
import crypto from "crypto"
import mockFs from "mock-fs"
import path from "path"
import { Client } from "pg"
import type { QueryResult } from "pg"
import {
  createDatabaseMigration,
  databaseNeedsMigration,
  migrateDatabase,
} from "."

vi.mock("pg", () => {
  const Client = vi.fn(
    class {
      query = vi.fn()
    },
  )
  return { Client }
})

const getDigestFromString = (str: string) =>
  crypto
    .createHash("md5")
    .update(new Uint8Array(Buffer.from(str, "utf-8")))
    .digest("hex")

describe("databaseNeedsMigration()", () => {
  afterEach(() => {
    mockFs.restore()
  })

  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(databaseNeedsMigration(new Client())).rejects.toThrow(
      /^The directory .* does not exist$/,
    )
  })

  it("returns true when database does not contain migration table", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Check if migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: false }] } as QueryResult)

    const actual = await databaseNeedsMigration(client)

    expect(actual).toBe(true)
    expect(mockQuery.mock.calls).toEqual([[expect.any(String), ["migrations"]]])
  })

  it("returns true when there are migrations that have not been applied to database", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200102030405.sql": "migration1",
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
    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
    ])
  })

  it("throws when migration is in database and not in filesystem", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
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
          { key: "20200102030405", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
        ],
      } as QueryResult)

    await expect(databaseNeedsMigration(client)).rejects.toThrow(
      "Migration 20200102030405 has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files",
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
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
          { key: "20200102030405", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { key: "20200102030406", md5: "99836b0f4ca50ed7ed998c0141a334e3" },
        ],
      } as QueryResult)

    await expect(databaseNeedsMigration(client)).rejects.toThrow(
      "Migration 20200102030406.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database",
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
    ])
  })

  it("returns false when database does not need migration with all arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrationDir")]: {
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
          { key: "20200102030405", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { key: "20200102030406", md5: "99836b0f4ca50ed7ed998c0141a334e4" },
        ],
      } as QueryResult)

    const actual = await databaseNeedsMigration(
      client,
      "migrationDir",
      "migrationTable",

      { debug: message => console.debug(message) },
    )

    expect(actual).toBe(false)

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrationTable"]],
      [expect.any(String)],
    ])
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
          { key: "20200102030405", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { key: "20200102030406", md5: "99836b0f4ca50ed7ed998c0141a334e4" },
        ],
      } as QueryResult)

    const actual = await databaseNeedsMigration(client)

    expect(actual).toBe(false)

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
    ])
  })
})

describe("migrateDatabase()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(migrateDatabase(new Client())).rejects.toThrow(
      /^The directory .* does not exist$/,
    )
  })

  it("creates migration table if it does not exist", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: false }] } as QueryResult)
      // Create migration table
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(client)

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
      [expect.any(String), ["migrations"]],
      [expect.stringMatching(/^create\stable\s.*/)],
      [expect.any(String)],
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
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
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({ rows: [] as unknown[] } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await migrateDatabase(client)

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
    ])
  })

  it("throws when migration is in database and not in filesystem", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          { key: "20200101000000", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
        ],
      } as QueryResult)
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(migrateDatabase(client)).rejects.toThrow(
      "Migration 20200101000000 has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files",
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
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
      // Check migration table exists
      .mockResolvedValueOnce({ rows: [{ exists: true }] } as QueryResult)
      // Select existing digests
      .mockResolvedValueOnce({
        rows: [
          { key: "20200101000000", md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { key: "20200101000001", md5: "99836b0f4ca50ed7ed998c0141a334e3" },
        ],
      } as QueryResult)
      // Release lock
      .mockResolvedValueOnce({ rows: [{ released: true }] } as QueryResult)

    await expect(migrateDatabase(client)).rejects.toThrow(
      "Migration 20200101000001_second_migration.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database",
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(Number), expect.any(Number)]],
    ])
  })

  it("applies migration with transaction", async () => {
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
      [path.join(process.cwd(), "migrations")]: files.reduce(
        (map, { filename, content }) => {
          map[filename] = content
          return map
        },
        {} as Record<string, string>,
      ),
    })

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
        // Check migration table exists
        return { rows: [{ exists: true }] } as QueryResult
      }
      if (queryCount === 3) {
        // Select existing digests
        return { rows: [] as unknown[] } as QueryResult
      }
      if (queryCount < 101 * 4 + 3) {
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

    expect(mockQuery.mock.calls).toEqual([
      [
        "select pg_try_advisory_lock($1, $2) as acquired",
        [expect.any(Number), expect.any(Number)],
      ],
      [
        `select exists (
        select
        from information_schema.tables
        where table_schema = 'public'
        and table_name = $1
      )`,
        ["migrations"],
      ],
      ["select key, md5 from migrations"],
      ...files
        .map(({ filename, content, digest }) => [
          ["begin transaction"],
          [content],
          [
            "insert into migrations (key, md5) values ($1, $2)",
            [filename.slice(0, 14), digest],
          ],
          ["commit"],
        ])
        .flatMap(command => command),
      [
        "select pg_advisory_unlock($1, $2) as released",
        [expect.any(Number), expect.any(Number)],
      ],
    ])
  })

  it("applies migration without transaction", async () => {
    const migration = "-- no_transaction\nmigration1"

    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "20200101000000.sql": migration,
      },
    })

    const client = new Client()
    const mockQuery = (
      vi.spyOn(client, "query") as MockInstance<() => Promise<QueryResult>>
    )
      // Acquire lock
      .mockResolvedValueOnce({ rows: [{ acquired: true }] } as QueryResult)
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

    expect(mockQuery.mock.calls).toEqual([
      [
        "select pg_try_advisory_lock($1, $2) as acquired",
        [expect.any(Number), expect.any(Number)],
      ],
      [
        `select exists (
        select
        from information_schema.tables
        where table_schema = 'public'
        and table_name = $1
      )`,
        ["migrations"],
      ],
      ["select key, md5 from migrations"],
      [migration],
      [
        "insert into migrations (key, md5) values ($1, $2)",
        ["20200101000000", "4ce5485a7e94e5f5a7c9fd3357ced0af"],
      ],
      [
        "select pg_advisory_unlock($1, $2) as released",
        [expect.any(Number), expect.any(Number)],
      ],
    ])
  })
})

describe("createDatabaseMigration()", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(createDatabaseMigration()).rejects.toThrow(
      /^The directory .* does not exist$/,
    )
  })

  it("creates file with required arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })
    vi.setSystemTime(new Date("2020-01-02T03:04:05Z"))

    const actual = await createDatabaseMigration()

    expect(actual).toBe(
      path.join(process.cwd(), "migrations", "20200102030405.sql"),
    )
  })

  it("creates file with all arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrationDir")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
        "my-file.sql": "ignored",
      },
    })
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
