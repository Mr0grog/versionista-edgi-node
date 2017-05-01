# versoinista-edgi-node

This is a version of [versionista-outputter](https://github.com/edgi-govdata-archiving/versionista-outputter) that has been rewritten in Node.js and JSDom.

Why? Speed is important here. Scraping Versionista can take a *long* time. We don’t need the overhead of a browser (like loading and executing images, CSS, and JavaScript) because all the necessary content is in the inital HTML payload. Parallelizing operations is also a little easier (for me, at least) in Node than in Ruby—and we absolutely ought to be doing more in parallel.


## Installation

You’ll need Node.js. Then you should be able to globally install this with:

```sh
$ npm install -g https://github.com/Mr0grog/versionista-edgi-node.git
```

Then run it like so:

```sh
$ scrape-versionista --email EMAIL --password PASSWORD --after '2017-03-22' --format csv --output './scrape/versions.csv'
```

Alternatively, you can clone this repo, then:

```sh
$ yarn install
# Or if you don't have yarn:
$ npm install

# And run it:
$ ./bin/scrape-versionista --email EMAIL --password PASSWORD --after '2017-03-22' --format csv --output './scrape/versions.csv'
```


## Usage

This has the same basic capabilities as `versionista-outputter`, but can also save the versioned HTML (and diffs).

For basic info:

```sh
$ scrape-versionista --help
```

### Options

- `--email STRING` **Required!** The E-mail address of Versionista Account. You can also use an env var instead: `VERSIONISTA_EMAIL`

- `--password STRING` **Required!** The password of Versionista Account. You can also use an env var instead: `VERSIONISTA_PASSWORD`

- `--after DATE|HOURS` Only check versions captured after this date. It can be an ISO 8601 date string like `2017-03-01T00:00:00Z` or a number, representing hours before the current time.

- `--before DATE|HOURS` Only check versions captured before this date. It can be an ISO 8601 date string like `2017-03-01T00:00:00Z` or a number, representing hours before the current time.

- `--format FORMAT` The output format. One of: `csv`, `json`, `json-stream`. [default: `json`]

- `--output FILEPATH` Write output to this file instead of directly to your console on stdout.

- `--save-content` If set, the raw HTML of each captured version will also be saved. Files are written to the working directory or, if `--output` is specified, the same directory as the output file.

- `--save-diffs` If set, the HTML of diffs between a version and its previous version will also be saved.Files are written to the working directory or, if `--output` is specified, the same directory as the output file.


## Examples

ALL the options!

```sh
$ scrape-versionista --email 'somebody@somewhere.com' --password somepassword --after '2017-02-01' --before '2017-03-01' --format csv --output './scrape/versions.csv' --save-content --save-diffs
```

Use environment variables for credentials:

```sh
$ export VERSIONISTA_EMAIL='somebody@somewhere.com'
$ export VERSIONISTA_PASSWORD=somepassword
$ scrape-versionista --after '2017-02-01' --before '2017-03-01' --format csv --output './scrape/versions.csv' --save-content --save-diffs
```

Specifying time as hours ago instead of a date:

```sh
# Startign 5 hours ago
$ scrape-versionista --after 5
# Decimals are accepted, so you can start 30 minutes ago, too
$ scrape-versionista --after 0.5
```


## Contributing Guidelines

We love improvements to our tools! EDGI has general [guidelines for contributing](https://github.com/edgi-govdata-archiving/overview/blob/master/CONTRIBUTING.md) to all of our organizational repos.


## License & Copyright

Copyright (C) 2017 Environmental Data and Governance Initiative (EDGI)
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3.0.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the [`LICENSE`](https://github.com/edgi-govdata-archiving/web-monitoring-versionista-scraper/blob/master/LICENSE) file for details.
