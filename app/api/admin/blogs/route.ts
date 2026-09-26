import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/lib/mongodb';
import Blog from '@/models/Blog';
import { sanitizeBlogHtml } from '@/lib/sanitize-blog-html';
import { blogInputSchema } from '@/lib/validation/blog';
import { readJson, withAdmin } from '@/lib/http/admin-handler';
import { validationError } from '@/lib/http/errors';
import { renderBlogSnapshot } from '@/lib/render/blog';
import { invalidateRelatedPosts } from '@/lib/blog-content/related-index';
import { notifySiteWebhook } from '@/lib/webhook';
import { assertBlogAuthorIsUsable } from '@/lib/admin/blog-author';
import { createBlogRevision } from '@/lib/blog-revisions';
import type { IBlog } from '@/models/Blog';

export const dynamic = 'force-dynamic';

export const GET = withAdmin(async (_req, { site }) => {
  await connectToDatabase();
  const blogs = await Blog.find({ siteId: site.id }).sort({ createdAt: -1, _id: -1 }).exec();
  return NextResponse.json(blogs);
});

export const POST = withAdmin(async (req, { user, site }) => {
  const parsed = blogInputSchema.safeParse(await readJson(req));
  if (!parsed.success) throw validationError(parsed.error.flatten(), 'Invalid blog payload');

  const data = { ...parsed.data };
  delete data.createdAt;
  const status = data.status ?? 'publish';
  const content = sanitizeBlogHtml(data.content);
  const rendered = await renderBlogSnapshot(content);

  await connectToDatabase();
  await assertBlogAuthorIsUsable({
    authorId: data.authorId,
    siteId: site.id,
    blogStatus: status,
  });
  let blog: IBlog | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const [created] = await Blog.create(
        [
          {
            ...data,
            content,
            rendered,
            status,
            publishedAt: status === 'publish' ? new Date() : null,
            siteId: site.id,
            createdBy: user.id,
            updatedBy: user.id,
          },
        ],
        { session },
      );
      blog = created;
      await createBlogRevision({
        siteId: site.id,
        blog: created,
        action: 'created',
        createdBy: user.id,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
  if (!blog) throw new Error('Blog creation did not complete');
  const savedBlog = blog as IBlog;
  invalidateRelatedPosts(site.id);
  if (savedBlog.status === 'publish') {
    notifySiteWebhook(site.id, {
      type: 'content.published',
      contentType: 'post',
      slug: savedBlog.slug,
      id: savedBlog._id.toString(),
    });
  }
  return NextResponse.json(savedBlog, { status: 201 });
});
