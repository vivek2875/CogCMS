import { NextResponse } from 'next/server';
import connectToDatabase from '@/lib/mongodb';
import Blog from '@/models/Blog';
import BlogRevision from '@/models/BlogRevision';
import { notFound, validationError } from '@/lib/http/errors';
import { withAdmin } from '@/lib/http/admin-handler';

export const dynamic = 'force-dynamic';
type Params = { slug: string };

/** Lists revision metadata only; snapshots are fetched deliberately for inspection. */
function positiveInteger(value: string | null, fallback: number, maximum?: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw validationError({ value }, 'Invalid pagination parameters');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw validationError({ value }, 'Invalid pagination parameters');
  }
  return parsed;
}

export const GET = withAdmin<Params>(async (req, { params, site }) => {
  const { slug } = await params;
  const page = positiveInteger(req.nextUrl.searchParams.get('page'), 1);
  const limit = positiveInteger(req.nextUrl.searchParams.get('limit'), 20, 100);
  await connectToDatabase();
  const blog = await Blog.findOne({ slug, siteId: site.id }).select('_id').lean().exec();
  if (!blog) throw notFound('Blog');

  const filter = { siteId: site.id, blogId: blog._id };
  const [revisions, total] = await Promise.all([
    BlogRevision.find(filter)
      .select('_id action createdAt createdBy restoredFromRevisionId')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'createdBy', select: 'name' })
      .lean()
      .exec(),
    BlogRevision.countDocuments(filter).exec(),
  ]);
  return NextResponse.json({
    data: revisions,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});
