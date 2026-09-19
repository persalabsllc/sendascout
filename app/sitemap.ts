import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...["property-check", "vehicle-check", "purchase-verification", "project-check", "custom", "missions"].map(slug => ({ url: `https://sendascout.com/${slug}`, changeFrequency: "weekly" as const, priority: 0.9 })),
    { url: "https://sendascout.com", changeFrequency: "weekly", priority: 1 },
    { url: "https://sendascout.com/request", changeFrequency: "monthly", priority: 0.8 },
    { url: "https://sendascout.com/scout", changeFrequency: "monthly", priority: 0.8 },
    { url: "https://sendascout.com/policies", changeFrequency: "monthly", priority: 0.4 },
    { url: "https://sendascout.com/terms", changeFrequency: "monthly", priority: 0.4 },
    { url: "https://sendascout.com/privacy", changeFrequency: "monthly", priority: 0.4 },
  ];
}
