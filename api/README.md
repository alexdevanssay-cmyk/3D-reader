# 3D Reader AI Gateway

This endpoint is a small server-side proxy for the OpenAI Responses API.

## Environment

Set:

- `OPENAI_API_KEY`: OpenAI API credential; never put this in GitHub Pages.
- `OPENAI_MODEL`: optional, defaults to `gpt-6-astra`.
- `READER3D_ALLOWED_ORIGIN`: recommended `https://alexdevanssay-cmyk.github.io`.

## Deployment

The endpoint is compatible with Vercel's Node-style `api/*.js` functions.

After deployment, configure the GitHub Pages application with the public endpoint, for example:

`https://<your-gateway-domain>/api/ai`

The browser sends only the semantic 3D context and conversation; for the costing task (« Chiffrage »), also the traced values of the quote (`costing_trace`, read only), with the internal amounts (rates, costs, prices, margins, losses on melting, TRS) masked unless the user ticks the box that sends them. The OpenAI credential stays on the gateway.

The gateway uses the OpenAI Responses API with Structured Outputs and function calling. The functions expose only data already present in the context sent by 3D Reader. For the costing task, the answer explains the traced values in `analyse_chiffrage`; it never sets a value.
