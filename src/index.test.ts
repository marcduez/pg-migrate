import mockFs from "mock-fs"
import { newDb } from "pg-mem"
import {
  createDatabaseMigration,
  databaseNeedsMigration,
  migrateDatabase,
} from "."

const { Client } = newDb().adapters.createPg()

afterEach(() => {
  mockFs.restore()
})

describe("databaseNeedsMigration()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(databaseNeedsMigration(Client)).rejects.toThrow(
      /^The directory .* does not exist$/
    )
  })

  describe("when migration directory exists", () => {
    it.todo("returns true when database does not contain migration table")

    it.todo(
      "returns true when there are migrations that have not been applied to database"
    )

    it.todo(
      "returns false when database does not need migration with all arguments set"
    )

    it.todo(
      "returns false when database does not need migration with required arguments set"
    )
  })
})

describe("migrateDatabase()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(migrateDatabase(Client)).rejects.toThrow(
      /^The directory .* does not exist$/
    )
  })

  it.todo("creates migration table if it does not exist")
  it.todo("throws when migration exists in table and not in files")
  it.todo(
    "throws when migration digest in database does not match digest in files"
  )
  it.todo("applies migrations")
  it.todo("acquires lock")
})

describe("createDatabaseMigration()", () => {
  it("throws when migration directory does not exist", async () => {
    mockFs({})

    await expect(createDatabaseMigration()).rejects.toThrow(
      /^The directory .* does not exist$/
    )
  })

  it.todo("creates file in empty directory")

  it.todo("creates file in non-empty directory with all arguments set")

  it.todo("creates file in non-empty directory with required arguments set")
})
