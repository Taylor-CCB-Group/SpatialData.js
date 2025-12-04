As of writing, the `zod-ome-ngff` npm package seems to be lacking some salient details.

I also found that the actual data I have output from spatialdata 0.5.0 has `version: "0.4-dev-spatialdata"`... which of course isn't a `z.literal('0.4')`...

For the hopefully very short-term, I'm including some code from `zod-ome-ngff` locally, with tweaks (slippery slope)