// api/impact.js
export default function handler(req, res) {

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    letters_total: 22420,
    facebook_views: 1759086,   
    insta_views: 933609,
    meta_views: 2692695,
    youtube_views: 710267,
    tiktok_views: 232000,
    sum_views: 3634962,
    hours_views: 46554,
    last_update: "2026-03-30T12:00:00.000Z"
  });

}