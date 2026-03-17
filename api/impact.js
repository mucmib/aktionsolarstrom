// api/impact.js
export default function handler(req, res) {

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    letters_total: 22420,
    facebook_views: 1475221,   
    insta_views: 855427,
    meta_views: 2330648,
    youtube_views: 672360,
    tiktok_views: 181000,
    sum_views: 3048797,
    hours_views: 45217,
    last_update: "2026-03-17T14:00:00.000Z"
  });

}