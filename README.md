# bookorbit-plugin-oopdf

BookOrbit indexer plugin. Drop into `<APP_DATA_PATH>/plugins/indexers/oceanofpdf/`.

## Settings

- **File variant** (`fileVariant`): which format to fetch, `epub` (default) or `pdf`.
- **FlareSolverr URL** (`flareSolverrUrl`): the FlareSolverr endpoint used to solve the site's Cloudflare challenge.
- **FlareSolverr token** (`flareSolverrToken`): an optional auth token for the FlareSolverr instance.

## Requirements

BookOrbit with resolveFile headers support (PLUGIN_API_VERSION 1)
