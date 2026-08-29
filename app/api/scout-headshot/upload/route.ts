import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { requireAppUser } from "@/lib/app-user";

export async function POST(request: Request) {
  try {
    const body = await request.json() as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const user = await requireAppUser("scout");
        if (user.role !== "scout" && user.role !== "admin") throw new Error("Only Scouts can upload a profile photo.");
        if (!pathname.startsWith("scout-headshots/upload/") || pathname.includes("..")) throw new Error("Invalid profile photo path.");
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"],
          maximumSizeInBytes: 10 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ scoutId: user.id }),
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload could not be authorized." }, { status: 400 });
  }
}
