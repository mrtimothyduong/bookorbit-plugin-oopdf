# bookorbit-plugin-oopdf

BookOrbit indexer plugin. Drop into `<APP_DATA_PATH>/plugins/indexers/oceanofpdf/`.

## Plugin Requirements
- BookOrbit with resolveFile headers support (PLUGIN_API_VERSION 1)
- A [Flaresolverr](https://github.com/FlareSolverr/FlareSolverr) instance

## Plugin Settings

- **Base URL**: Leave as-is unless the domain changes
- **Session ID**: Leave blank/as-is unless required
- **File variant** (`fileVariant`): which format to fetch, `epub` (default) or `pdf`.
- **FlareSolverr URL** (`flareSolverrUrl`): the FlareSolverr endpoint used to solve the site's Cloudflare challenge. example: `http://192.168.1.123:8191/v1`
- **FlareSolverr token** (`flareSolverrToken`): an optional auth token for the FlareSolverr instance. Leave empty if you do not have AuthToken requirement for FlareSolverr

## AVAILABILITY
- **Enabled**: Enable or Disabled
- **Allow private addresses**: Enable if targeting local private address IP ranges


