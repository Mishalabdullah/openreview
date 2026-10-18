import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			category: z
				.enum(['Engineering', 'Code review', 'Open source', 'Changelog'])
				.default('Engineering'),
			cover: z
				.enum(['refactor', 'conversation', 'source', 'diff'])
				.default('refactor'),
			featured: z.boolean().default(false),
			author: z.string().default('The OpenReview team'),
		}),
});

export const collections = { blog };
