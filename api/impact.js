// api/impact.js
export default function handler(req, res) {

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    letters_total: 22420,
    meta_views: 2029523,
    youtube_views: 617568,
    tiktok_views: 173000,
    hours_views: 44047,
    last_update: "2026-03-12T14:00:00.000Z"
  });

}