import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/lib/mongodb';
import Blog, { type IBlog } from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import { createBlogRevision, isRevisionId } from '@/lib/blog-revisions';
import { sanitizeBlogHtml } from '@/lib/sanitize-blog-html';
import { renderBlogSnapshot } from '@/lib/render/blog';
import { assertBlogAuthorIsUsable } from '@/lib/admin/blog-author';
import { notFound, validationError } from '@/lib/http/errors';
import { withAdmin } from '@/lib/http/admin-handler';
import { invalidateRelatedPosts } from '@/lib/blog-content/related-index';

export const dynamic = 'force-dynamic';
type Params = { slug: string; revisionId: string };

export const POST = withAdmin<Params>(async (_req, { params, site, user }) => {
  const { slug, revisionId } = await params;
  if (!isRevisionId(revisionId)) throw validationError({ revisionId }, 'Invalid revision id');
  await connectToDatabase();

  const existing = await Blog.findOne({ slug, siteId: site.id }).exec();
  if (!existing) throw notFound('Blog');
  const source = await BlogRevision.findOne({
    _id: revisionId,
    blogId: existing._id,
    siteId: site.id,
  })
    .lean()
    .exec();
  if (!source) throw notFound('Revision');

  // Rendering happens before the transaction; only the compact, prepared result is written atomically.
  const content = sanitizeBlogHtml(source.snapshot.content);
  const rendered = await renderBlogSnapshot(content);
  await assertBlogAuthorIsUsable({
    authorId: source.snapshot.authorId?.toString() ?? null,
    siteId: site.id,
    blogStatus: existing.status,
  });

  let restored: IBlog | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await Blog.findOne({ _id: existing._id, siteId: site.id })
        .session(session)
        .exec();
      if (!current) throw notFound('Blog');
      const revision = await BlogRevision.findOne({
        _id: revisionId,
        blogId: current._id,
        siteId: site.id,
      })
        .session(session)
        .lean()
        .exec();
      if (!revision) throw notFound('Revision');
      await assertBlogAuthorIsUsable({
        authorId: revision.snapshot.authorId?.toString() ?? null,
        siteId: site.id,
        blogStatus: current.status,
        session,
      });
      restored = await Blog.findOneAndUpdate(
        { _id: current._id, siteId: site.id },
        {
          $set: {
            ...revision.snapshot,
            content,
            rendered,
            // URL and publishing state are intentionally current, not historical.
            slug: current.slug,
            status: current.status,
            publishedAt: current.publishedAt,
            updatedBy: user.id,
          },
        },
        { returnDocument: 'after', runValidators: true, session },
      ).exec();
      if (!restored) throw notFound('Blog');
      await createBlogRevision({
        siteId: site.id,
        blog: restored,
        action: 'restored',
        createdBy: user.id,
        restoredFromRevisionId: revision._id,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
  if (!restored) throw notFound('Blog');
  invalidateRelatedPosts(site.id);
  return NextResponse.json(restored);
});
