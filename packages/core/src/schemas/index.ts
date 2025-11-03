/**
 * Zod schemas for SpatialData validation
 */

import { z } from 'zod';

// this is generated from https://github.com/ome/ngff/blob/8cbba216e37407bd2d4bd5c7128ab13bd0a6404e/schemas/image.schema
// -> https://stefanterdell.github.io/json-schema-to-zod-react/ (the output of which had lots of errors
// which were 'fixed' by Cursor (gemini-2.5-pro)... so entirely possible that something is not entirely correct.)
export const imageSchema = z
  .object({
    ome: z
      .object({
        multiscales: z
          .array(
            z.object({
              name: z.string().optional(),
              datasets: z
                .array(
                  z.object({
                    path: z.string(),
                    coordinateTransformations: z
                      .array(
                        z.union([
                          z.object({
                            type: z.literal("scale"),
                            scale: z.array(z.number()).min(2),
                          }),
                          z.object({
                            type: z.literal("translation"),
                            translation: z.array(z.number()).min(2),
                          }),
                        ])
                      )
                      .min(1),
                  })
                )
                .min(1),
              axes: z
                .array(
                  z.union([
                    z.object({
                      name: z.string(),
                      type: z.enum(["channel", "time", "space"]),
                    }),
                    z.object({
                      name: z.string(),
                      type: z
                        .any()
                        .refine(
                          (value) =>
                            !z
                              .enum(["space", "time", "channel"])
                              .safeParse(value).success,
                          "Invalid input: Should NOT be valid against schema"
                        )
                        .optional(),
                    }),
                  ])
                )
                .min(2)
                .max(5),
              coordinateTransformations: z
                .array(
                  z.union([
                    z.object({
                      type: z.literal("scale"),
                      scale: z.array(z.number()).min(2),
                    }),
                    z.object({
                      type: z.literal("translation"),
                      translation: z.array(z.number()).min(2),
                    }),
                  ])
                )
                .min(1)
                .optional(),
            })
          )
          .min(1)
          .describe("The multiscale datasets for this image"),
        omero: z
          .object({
            channels: z.array(
              z.object({
                window: z
                  .object({
                    end: z.number(),
                    max: z.number(),
                    min: z.number(),
                    start: z.number(),
                  })
                  .optional(),
                label: z.string().optional(),
                family: z.string().optional(),
                color: z.string().optional(),
                active: z.boolean().optional(),
              })
            ),
          })
          .optional(),
        version: z
          .literal("0.5")
          .describe("The version of the OME-Zarr Metadata"),
      })
      .describe("The versioned OME-Zarr Metadata namespace"),
  })
  .describe("The zarr.json attributes key");

export type NgffImage = z.infer<typeof imageSchema>;


/**
 * Schema for coordinate transformations
 */
export const coordinateTransformationSchema = z.object({
  type: z.string(),
  transform: z.array(z.array(z.number())),
});

/**
 * Schema for SpatialData metadata
 */
export const spatialDataSchema = z.object({
  version: z.string(),
  coordinateSystems: z.record(z.string(), coordinateTransformationSchema),
});

export type CoordinateTransformation = z.infer<typeof coordinateTransformationSchema>;
export type SpatialData = z.infer<typeof spatialDataSchema>;
