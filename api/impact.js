// api/impact.js
export default function handler(req, res) {

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    letters_total: 22420,
    facebook_views: 1544423,   
    insta_views: 868228,
    meta_views: 2412651,
    youtube_views: 683894,
    tiktok_views: 208000,
    sum_views: 3304545,
    hours_views: 45879,
    last_update: "2026-03-18T18:00:00.000Z"
  });

}