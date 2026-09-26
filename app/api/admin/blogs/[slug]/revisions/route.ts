import { NextResponse } from 'next/server';
import connectToDatabase from '@/lib/mongodb';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import { notFound } from '@/lib/http/errors';
import { withAdmin } from '@/lib/http/admin-handler';

export const dynamic = 'force-dynamic';
type Params = { slug: string };

/** Lists revision metadata only; snapshots are fetched deliberately for inspection. */
export const GET = withAdmin<Params>(async (_req, { params, site }) => {
  const { slug } = await params;
  await connectToDatabase();
  const blog = await Blog.findOne({ slug, siteId: site.id }).select('_id').lean().exec();
  if (!blog) throw notFound('Blog');

  const revisions = await BlogRevision.find({ siteId: site.id, blogId: blog._id })
    .select('_id action createdAt createdBy restoredFromRevisionId')
    .sort({ createdAt: -1, _id: -1 })
    .populate({ path: 'createdBy', select: 'name' })
    .lean()
    .exec();
  return NextResponse.json(revisions);
});
