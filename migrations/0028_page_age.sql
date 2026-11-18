-- Age in days of the article a new visit landed on (from the page's article:published_time / datePublished /
-- <time datetime>), measuring only: crawlers land Direct on years-old archive articles, readers rarely do.
ALTER TABLE sessions ADD COLUMN page_age INTEGER;
ALTER TABLE held_visits ADD COLUMN page_age INTEGER;
