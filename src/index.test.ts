import mockFs from "mock-fs"
import path from "path"
import { Client, QueryResult } from "pg"
import {
  createDatabaseMigration,
  databaseNeedsMigration,
  migrateDatabase,
} from "."

const mockQuery = jest.fn<Promise<Partial<QueryResult<any>>>, any[]>()

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    query: mockQuery,
  })),
}))

afterEach(() => {
  mockFs.restore()
})

describe("databaseNeedsMigration()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(databaseNeedsMigration(new Client())).rejects.toThrow(
      /^The directory .* does not exist$/
    )
  })

  it("returns true when database does not contain migration table", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] })

    const actual = await databaseNeedsMigration(new Client())

    expect(actual).toBe(true)

    expect(mockQuery.mock.calls).toEqual([[expect.any(String), ["migrations"]]])
  })

  it("returns true when there are migrations that have not been applied to database", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] })

    const actual = await databaseNeedsMigration(new Client())

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
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [{ version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" }],
      })

    await expect(databaseNeedsMigration(new Client())).rejects.toThrow(
      "Migration 1 has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files"
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
    ])
  })

  it("throws when migration in database and filesystem have different digests", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [
          { version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { version: 2, md5: "99836b0f4ca50ed7ed998c0141a334e3" },
        ],
      })

    await expect(databaseNeedsMigration(new Client())).rejects.toThrow(
      "Migration 0002.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database"
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
    ])
  })

  it("returns false when database does not need migration with all arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrationDir")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [
          { version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { version: 2, md5: "99836b0f4ca50ed7ed998c0141a334e4" },
        ],
      })

    const actual = await databaseNeedsMigration(
      new Client(),
      "migrationDir",
      "migrationTable",
      { debug: message => console.debug(message) }
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
        "0001.sql": "migration1",
        "0002.sql": "migration2",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [
          { version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { version: 2, md5: "99836b0f4ca50ed7ed998c0141a334e4" },
        ],
      })

    const actual = await databaseNeedsMigration(new Client())

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
      /^The directory .* does not exist$/
    )
  })

  it("creates migration table if it does not exist", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await migrateDatabase(new Client())

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.stringMatching(/^create\stable\s.*/)],
      [expect.any(String)],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })

  it("ignores files with invalid names", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "my-file.sql": "migration1",
      },
    })

    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await migrateDatabase(new Client())

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })

  it("throws when migration is in database and not in filesystem", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [{ version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" }],
      })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await expect(migrateDatabase(new Client())).rejects.toThrow(
      "Migration 1 has digest 7efb2a07775469cb63c3b4b2d8302e8e in database, and does not exist in files"
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })

  it("throws when migration in database and filesystem have different digests", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({
        rows: [
          { version: 1, md5: "7efb2a07775469cb63c3b4b2d8302e8e" },
          { version: 2, md5: "99836b0f4ca50ed7ed998c0141a334e3" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await expect(migrateDatabase(new Client())).rejects.toThrow(
      "Migration 0002.sql has digest 99836b0f4ca50ed7ed998c0141a334e4 in files, and digest 99836b0f4ca50ed7ed998c0141a334e3 in database"
    )

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })

  it("applies migration with transaction", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await migrateDatabase(new Client())

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      ["begin transaction"],
      ["migration1"],
      [
        expect.stringMatching(/^insert\sinto\s.*/),
        [1, "7efb2a07775469cb63c3b4b2d8302e8e"],
      ],
      ["commit"],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })

  it("applies migration without transaction", async () => {
    const migration = "-- no_transaction\nmigration1"

    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": migration,
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ released: true }] })

    await migrateDatabase(new Client())

    expect(mockQuery.mock.calls).toEqual([
      [expect.any(String), [expect.any(BigInt)]],
      [expect.any(String), ["migrations"]],
      [expect.any(String)],
      [migration],
      [
        expect.stringMatching(/^insert\sinto\s.*/),
        [1, "4ce5485a7e94e5f5a7c9fd3357ced0af"],
      ],
      [expect.any(String), [expect.any(BigInt)]],
    ])
  })
})

describe("createDatabaseMigration()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(createDatabaseMigration()).rejects.toThrow(
      /^The directory .* does not exist$/
    )
  })

  it("creates file in empty directory", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {},
    })

    const actual = await createDatabaseMigration()

    expect(actual).toBe(path.join(process.cwd(), "migrations", "0001.sql"))
  })

  it("creates file in non-empty directory with all arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrationDir")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
        "my-file.sql": "ignored",
      },
    })

    const actual = await createDatabaseMigration(
      path.join(process.cwd(), "migrationDir")
    )

    expect(actual).toBe(path.join(process.cwd(), "migrationDir", "0003.sql"))
  })

  it("creates file in non-empty directory with required arguments set", async () => {
    mockFs({
      [path.join(process.cwd(), "migrations")]: {
        "0001.sql": "migration1",
        "0002.sql": "migration2",
      },
    })

    const actual = await createDatabaseMigration()

    expect(actual).toBe(path.join(process.cwd(), "migrations", "0003.sql"))
  })
})
