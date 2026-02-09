# pg-migrate

<span class="badge-npmversion"><a href="https://npmjs.org/package/@marcduez/pg-migrate" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@marcduez/pg-migrate.svg" alt="NPM version" /></a></span>

PostgreSQL database migrations, from script or the command line. There are many packages that do this, but this package makes the following assumptions:

1. Migrations are written in vanilla SQL. This library does not use a DSL for describing changes.
2. Migrations are one-way. There is no support for "down" migrations to undo "up" migrations, because I have never found that useful.
3. Migrations start with a yyyyMMddHHmmss timestamp, and can optionally have a name for clarity. E.g. `20260122153125.sql` or `20260122153125_create_user_table.sql`.
4. Unapplied migrations that are for earlier timestamps than the last applied migration will still be applied. If you merge a feature branch into main, and newer migrations exist on main, you migrations will still be run.
5. A lock is acquired around the migration process, so if two nodes try to migrate the same database at the same time, one should fail.
6. Conflicts are detected by comparing changes to the `schema.sql` file that is output after each migration batch.
7. When run from script, this library presumes you bring your own PG client. I like this because it makes it agnostic to how you configure your database. For instance, I like to use [dotenv](https://www.npmjs.com/package/dotenv) to keep development and environment database settings separate.

## ⚠️ BREAKING CHANGES IN VERSION 3

Having used this library in production for a while, I've made some changes to reduce friction in teams.

| Version 2                                                                        | Version 3                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sequentially numbered 4-digit migration filenames (e.g. `0001.sql`, `0002.sql`). | Timestamp-plus-optional-name filenames (e.g. `20260122153125.sql` or `20260122153125_create_user_table.sql`). |
| No use of `pg_dump`                                                              | `pg_dump` used to output schema file at the end of each migration batch.                                      |
| Conflicts based on two migrations with the same filename.                        | Conflicts based on conflicting changes to `schema.sql` file.                                                  |
| Migration table primary key is integer.                                          | Migration table primary key is migration filename.                                                            |

### Steps to migrate from version 2 to version 3

1. Get a SQL script that describes the schema and data of your production migrations table. It's usually best to use production because the applied-at timestamps will be realistic. Here's an example of how to do this with pg_dump:

```sh
$ pg_dump -U [user_name] -d [db_name] -t migrations --no-owner --no-privileges --inserts > migrations.sql
```

2. Create an empty database, named something like `pg_migrate_upgrade`. Run the script you exported to create the migrations table in the database you created above.
3. In your project directory, run the `migrate-v2-to-v3` command. It will drop and re-create the migration table in your new database while preserving applied-at timestamps, rename your migration files to the new format, and write a script to `pg_migrate_v2_to_v3_migration.sql` that you can run later in production or other environments:

```sh
$ DATABASE_URL="postgresql://user_name:password@localhost:5432/pg_migrate_upgrade" yarn pg-migrate migrate-v2-to-v3
```

4. In order to get a clean `schema.sql` file, I recommend you do the following:
   1. Drop the database you created in step 2 and re-create it.
   2. Run a complete migration on it, using your newly renamed migration files. This will generate a `schema.sql` file that contains only what the migration files describe, and nothing that has been added manually over time:

```sh
$ DATABASE_URL="postgresql://user_name:password@localhost:5432/pg_migrate_upgrade" yarn pg-migrate migrate
```

5. Run the `pg_migrate_v2_to_v3_migration.sql` on your production database (and your dev database and your test database and anywhere else you've run migrations) to drop and recreate the migration table using the new format.
6. Commit your renamed migration files and your `schema.sql` file to source control. When your production environment next evaluates migrations it should find that there are no migrations to apply.

## Installation

```sh
$ npm install @marcduez/pg-migrate

$ yarn add @marcduez/pg-migrate
```

## General Usage

### Using the CLI

To view usage instructions for the CLI, use the `--help` command:

```sh
$ npm run pg-migrate --help

$ yarn pg-migrate --help
```

### Environment Variables

The CLI accepts the following environment variables:

```
PGURI or DATABASE_URL - Database connection string. When supplied other variables are ignored.
PGUSER - Database user name.
PGHOST - Database server host or socket directory.
PGPASSWORD - Database password.
PGDATABASE - Database name to connect to.
PGPORT - Database server port.
```

Example:

```sh
$ PGURI=postgres://user:password@host:port/database npm run pg-migrate
```

### Creating a migration

In script:

```typescript
import { createDatabaseMigration } from "@marcduez/pg-migrate"

// Your create-database-migration script.
;(async () => {
  const filePath = await createDatabaseMigration()
  // Outputs something like `Database migration created: /path/to/project/migrations/20260208153000_create_user_table.sql`
  console.log(`Database migration created: ${filePath}`)
})()
```

Using the CLI:

```sh
$ npm run pg-migrate create

$ yarn pg-migrate create
```

### Migrating the database

In script:

```typescript
import { migrateDatabase } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your migrate-database script.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    await migrateDatabase(client)
  } finally {
    await client.end()
  }
})()
```

Using the CLI:

```sh
$ npm run pg-migrate migrate

$ yarn pg-migrate migrate
```

### Overwriting the md5 digest of a migration in the database with the one from a file

If you've been working on a migration, and the latest version of your file captures everything you've made to the database, but at the time you ran migrations the digest was different, you can use the `overwrite-md5` command to update the digest in the database to match the one from your file. This is not a common operation.

```typescript
import { overwriteDatabaseMd5 } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your migrate-database script.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    await overwriteDatabaseMd5(client, "20260122153125.sql")
  } finally {
    await client.end()
  }
})()
```

Using the CLI:

```sh
$ npm run pg-migrate overwrite-md5
# Then follow prompts

$ yarn pg-migrate overwrite-md5
# Then follow prompts
```

### Throwing if database is not fully migrated

```typescript
import { databaseNeedsMigration } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your application entrypoint.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    if (await databaseNeedsMigration(client)) {
      throw new Error("Database needs migrating!")
    }
  } finally {
    await client.end()
  }

  // Do stuff assuming database is fully migrated.
})()
```

### Running a migration without a transaction

Usually each migration is run within a transaction, that is rolled back on error. Some schema updates need to be run outside a transaction. If you want your migration to run outside a transaction, add the line `-- no_transaction` as the first line of your SQL file. Like the following:

```SQL
-- no_transaction

alter type my_enum add value 'new_value';
```
