import { NextResponse } from 'next/server';
import connectToDatabase from '@/lib/mongodb';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import { notFound, validationError } from '@/lib/http/errors';
import { withAdmin } from '@/lib/http/admin-handler';
import { isRevisionId } from '@/lib/blog-revisions';

export const dynamic = 'force-dynamic';
type Params = { slug: string; revisionId: string };

export const GET = withAdmin<Params>(async (_req, { params, site }) => {
  const { slug, revisionId } = await params;
  if (!isRevisionId(revisionId)) throw validationError({ revisionId }, 'Invalid revision id');
  await connectToDatabase();
  const blog = await Blog.findOne({ slug, siteId: site.id }).select('_id').lean().exec();
  if (!blog) throw notFound('Blog');
  const revision = await BlogRevision.findOne({
    _id: revisionId,
    blogId: blog._id,
    siteId: site.id,
  })
    .populate({ path: 'createdBy', select: 'name' })
    .lean()
    .exec();
  if (!revision) throw notFound('Revision');
  return NextResponse.json(revision);
});
