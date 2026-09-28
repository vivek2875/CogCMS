import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/lib/mongodb';
import Blog from '@/models/Blog';
import { sanitizeBlogHtml } from '@/lib/sanitize-blog-html';
import { blogInputSchema } from '@/lib/validation/blog';
import { readJson, withAdmin } from '@/lib/http/admin-handler';
import { notFound, validationError } from '@/lib/http/errors';
import { renderBlogSnapshot } from '@/lib/render/blog';
import { invalidateRelatedPosts } from '@/lib/blog-content/related-index';
import { deliveryEventType, notifySiteWebhook } from '@/lib/webhook';
import { assertBlogAuthorIsUsable } from '@/lib/admin/blog-author';
import BlogRevision from '@/models/BlogRevision';
import { createBlogRevision } from '@/lib/blog-revisions';
import type { IBlog } from '@/models/Blog';

export const dynamic = 'force-dynamic';
type Params = { slug: string };

export const GET = withAdmin<Params>(async (_req, { params, site }) => {
  const { slug } = await params;
  await connectToDatabase();
  const blog = await Blog.findOne({ slug, siteId: site.id }).exec();
  if (!blog) throw notFound('Blog');
  return NextResponse.json(blog);
});

export const PUT = withAdmin<Params>(async (req, { params, user, site }) => {
  const { slug } = await params;
  const parsed = blogInputSchema.partial().safeParse(await readJson(req));
  if (!parsed.success) throw validationError(parsed.error.flatten(), 'Invalid blog payload');

  await connectToDatabase();
  const existing = await Blog.findOne({ slug, siteId: site.id }).exec();
  if (!existing) throw notFound('Blog');

  const nextStatus = parsed.data.status ?? existing.status;
  const nextAuthorId =
    parsed.data.authorId === undefined ? existing.authorId?.toString() : parsed.data.authorId;
  await assertBlogAuthorIsUsable({
    authorId: nextAuthorId,
    siteId: site.id,
    blogStatus: nextStatus,
  });

  const update: Record<string, unknown> = { ...parsed.data, updatedBy: user.id };
  delete update.createdAt;
  if (parsed.data.content !== undefined) {
    const content = sanitizeBlogHtml(parsed.data.content);
    update.content = content;
    update.rendered = await renderBlogSnapshot(content);
  }
  if (parsed.data.status === 'publish' && !existing.publishedAt) update.publishedAt = new Date();

  let blog: IBlog | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Read inside the transaction so a legacy baseline is the exact pre-write state.
      const current = await Blog.findOne({ _id: existing._id, siteId: site.id })
        .session(session)
        .exec();
      if (!current) throw notFound('Blog');
      const hasHistory = await BlogRevision.exists({ siteId: site.id, blogId: current._id })
        .session(session)
        .exec();
      if (!hasHistory) {
        await createBlogRevision({
          siteId: site.id,
          blog: current,
          action: 'created',
          createdBy: current.createdBy,
          session,
        });
      }
      blog = await Blog.findOneAndUpdate(
        { _id: current._id, siteId: site.id },
        { $set: update },
        { returnDocument: 'after', runValidators: true, session },
      ).exec();
      if (!blog) throw notFound('Blog');
      await createBlogRevision({
        siteId: site.id,
        blog,
        action: 'updated',
        createdBy: user.id,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
  if (!blog) throw notFound('Blog');
  const savedBlog = blog as IBlog;
  invalidateRelatedPosts(site.id);
  const eventType = deliveryEventType(existing.status, savedBlog.status);
  if (eventType) {
    notifySiteWebhook(site.id, {
      type: eventType,
      contentType: 'post',
      slug: savedBlog.slug,
      id: savedBlog._id.toString(),
    });
  }
  return NextResponse.json(savedBlog);
});

export const DELETE = withAdmin<Params>(async (_req, { params, site }) => {
  const { slug } = await params;
  await connectToDatabase();
  let blog: IBlog | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      blog = await Blog.findOneAndDelete({ slug, siteId: site.id }, { session }).exec();
      if (!blog) throw notFound('Blog');
      await BlogRevision.deleteMany({ siteId: site.id, blogId: blog._id }, { session }).exec();
    });
  } finally {
    await session.endSession();
  }
  if (!blog) throw notFound('Blog');
  const deletedBlog = blog as IBlog;
  invalidateRelatedPosts(site.id);
  if (deletedBlog.status === 'publish') {
    notifySiteWebhook(site.id, {
      type: 'content.deleted',
      contentType: 'post',
      slug: deletedBlog.slug,
      id: deletedBlog._id.toString(),
    });
  }
  return NextResponse.json({ message: 'Deleted successfully' });
});
