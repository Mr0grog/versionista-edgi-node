'use strict';

// TODO: UUID assignment should happen independently of formatting
const uuid = require('../uuid.js');

/**
 * Converts scraped site data to JSON Stream format.
 * Each line is an independent JSON object representing a version.
 */
module.exports = function formatJsonStream (sites, options = {}) {
  const versionType = options.versionType || 'versions';

  const rows = [];

  // TODO: this would be better as a flatmap
  sites.forEach(site => {
    site.pages && site.pages.forEach(page => {
      page[versionType] && page[versionType].forEach(version => {
        const formatted = Object.assign({
          account: options.account,
          siteName: site.name,
          agency: agencyForSite(site),
          versionistaSiteUrl: site.url,
          versionistaPageUrl: page.versionistaUrl,
          pageUrl: page.url,
          pageTitle: page.title
        }, version);

        rows.push(formatted);
      });
    });
  });

  return rows.map(row => JSON.stringify(row)).join('\n');
}

function agencyForSite (site) {
  return site.name.split('-')[0].trim();
}
