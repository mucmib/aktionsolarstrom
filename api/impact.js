// api/impact.js
export default function handler(req, res) {

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    letters_total: 22420,
    meta_views: 1805062,
    youtube_views: 827279,
    tiktok_views: 166000,
    last_update: "2026-03-03T10:30:00.000Z"
  });

}