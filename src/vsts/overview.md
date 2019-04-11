# Hash and Cache

This Azure DevOps extension (and/or NPM package) allows you to wrap caching behavior around a command-line command.  Most common scenario is for npm install.  This task will hash the contents of your package.lock file, and if it is unchanged from previous runs download a cached copy of the node_modules folder from an Azure Storage account - and skip running npm install.

If package.lock is changed, it will not find a valid cache and will run npm install as normal (and optionally create a new cache entry and upload to Azure Storage).
