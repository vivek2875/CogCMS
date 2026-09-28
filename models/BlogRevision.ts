import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type BlogRevisionAction = 'created' | 'updated' | 'restored';

export interface BlogRevisionSnapshot {
  title: string;
  excerpt: string;
  content: string;
  imageUrl: string;
  tag: string;
  authorId: Types.ObjectId | null;
  category: string;
  tags: string[];
  faqs: { question: string; answer: string }[];
  keyTakeaways: string[];
  relatedSlugs: string[];
  tocOverrides: { id: string; label?: string; hidden?: boolean }[];
  metaTitle: string;
  metaDescription: string;
  keywords: string;
  isFeatured: boolean;
}

export interface IBlogRevision extends Document<Types.ObjectId> {
  siteId: Types.ObjectId;
  blogId: Types.ObjectId;
  snapshot: BlogRevisionSnapshot;
  action: BlogRevisionAction;
  createdBy: Types.ObjectId | null;
  restoredFromRevisionId: Types.ObjectId | null;
  createdAt: Date;
}

const FaqSchema = new Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
  },
  { _id: false },
);

const TocOverrideSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String },
    hidden: { type: Boolean },
  },
  { _id: false },
);

const SnapshotSchema = new Schema<BlogRevisionSnapshot>(
  {
    title: { type: String, required: true },
    excerpt: { type: String, default: '' },
    content: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    tag: { type: String, default: 'Insights' },
    authorId: { type: Schema.Types.ObjectId, ref: 'Author', default: null },
    category: { type: String, default: '' },
    tags: { type: [String], default: [] },
    faqs: { type: [FaqSchema], default: [] },
    keyTakeaways: { type: [String], default: [] },
    relatedSlugs: { type: [String], default: [] },
    tocOverrides: { type: [TocOverrideSchema], default: [] },
    metaTitle: { type: String, default: '' },
    metaDescription: { type: String, default: '' },
    keywords: { type: String, default: '' },
    isFeatured: { type: Boolean, default: false },
  },
  { _id: false },
);

const BlogRevisionSchema = new Schema<IBlogRevision>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, immutable: true },
    blogId: { type: Schema.Types.ObjectId, ref: 'Blog', required: true, immutable: true },
    snapshot: { type: SnapshotSchema, required: true, immutable: true },
    action: {
      type: String,
      enum: ['created', 'updated', 'restored'],
      required: true,
      immutable: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
    restoredFromRevisionId: {
      type: Schema.Types.ObjectId,
      ref: 'BlogRevision',
      default: null,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'blog_revisions' },
);

BlogRevisionSchema.pre('save', function preventRevisionChanges() {
  if (!this.isNew) throw new Error('Blog revisions are immutable');
});
for (const hook of ['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne'] as const) {
  BlogRevisionSchema.pre(hook, function preventRevisionChanges() {
    throw new Error('Blog revisions are immutable');
  });
}
BlogRevisionSchema.index({ siteId: 1, blogId: 1, createdAt: -1, _id: -1 });

const BlogRevision: Model<IBlogRevision> =
  mongoose.models.BlogRevision || mongoose.model<IBlogRevision>('BlogRevision', BlogRevisionSchema);

export default BlogRevision;
