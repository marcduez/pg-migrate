# pg-migrate

Package for applying migrations to a Postgres database

## Setting Up Local Environment

Even when using `yarn` as package manager, do this login dance with `npm`:

```sh
npm login --scope=@marcduez --registry=https://npm.pkg.github.com
> Username: [your Github username]
> Email: [your Github public email address]
> Password: [a generated personal access token with scopes read:packages and repo]
```

See [this page](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) for more details on using the Github NPM registry.

To generate a personal access token, go [here](https://github.com/settings/tokens).
