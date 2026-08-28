import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://sendascout.com", changeFrequency: "weekly", priority: 1 },
    { url: "https://sendascout.com/request", changeFrequency: "monthly", priority: 0.8 },
    { url: "https://sendascout.com/scout", changeFrequency: "monthly", priority: 0.8 },
  ];
}
