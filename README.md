# bookorbit-plugin-oopdf

BookOrbit indexer plugin for a site

## Plugin Requirements
- BookOrbit with resolveFile headers support (PLUGIN_API_VERSION 1)
  - This plugin works once [this PR](https://github.com/bookorbit/bookorbit/pull/1696) is committed to Main Branch
- A [Flaresolverr](https://github.com/FlareSolverr/FlareSolverr) instance

## Installation
1. Download [Git Repo](https://github.com/mrtimothyduong/bookorbit-plugin-oopdf/archive/refs/heads/main.zip) and unzip it
2. Log into your BookOrbit Web Portal & go to `Settings > Server > Requests`
3. Select the `Install plugin` button and upload the `index.mjs`
4. Configure the Plugin Settings including your FlareSolverr instance as seen below in `Plugin Settings`
5. Run a `Test Connection`
6. Search for books and the results should appear.
7. Test a book by selecting the release.

### Plugin Settings
- **Base URL**: Leave as-is unless the domain changes
- **Session ID**: Leave blank/as-is unless required
- **File variant** (`fileVariant`): which format to fetch, `epub` (default) or `pdf`.
- **FlareSolverr URL** (`flareSolverrUrl`): the FlareSolverr endpoint used to solve the site's Cloudflare challenge.
  - Example: `http://192.168.1.123:8191/v1`
- **FlareSolverr token** (`flareSolverrToken`): an optional auth token for the FlareSolverr instance. Leave empty if you do not have AuthToken requirement for FlareSolverr

### AVAILABILITY
- **Enabled**: Enable or Disabled. Turn on or off the plugin
- **Allow private addresses**: Enable if targeting local private address IP ranges
