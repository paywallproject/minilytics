-- Where in its country each site's real readers are (state/region), learned with site_audience. On a computer,
-- time on the page alone counts a brand-new visitor only inside these regions (lib/hold.ts): residential-proxy
-- crawlers sit on pages from home connections scattered across the country, while a local paper's readers are local.
CREATE TABLE site_regions (
  site_id TEXT NOT NULL,
  region TEXT NOT NULL,           -- "US/Illinois"
  readers INTEGER NOT NULL DEFAULT 0,
  interacted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, region)
);
