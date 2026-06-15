import { Stripe } from 'stripe';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/generate' && request.method === 'POST') {
      return generateMusic(request, env);
    }

    if (path === '/list' && request.method === 'GET') {
      return listTracks(env);
    }

    if (path.startsWith('/track/') && request.method === 'GET') {
      return getTrack(url, env);
    }

    return new Response('Music AI Worker', { status: 200 });
  }
};

async function generateMusic(request, env) {
  const { prompt, duration = 30, model = 'music-gen' } = await request.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Prompt is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Call OpenAI TTS API to generate speech from the prompt
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: prompt,
        voice: 'alloy',
        speed: 1.0,
        response_format: 'mp3'
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`OpenAI API error: ${errorData.error?.message || response.statusText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const trackId = `track_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store the audio in KV
    await env.MUSIC_AI.put(trackId, audioBuffer, {
      metadata: {
        prompt: prompt.substring(0, 100), // Limit metadata size
        duration: duration,
        model: model,
        createdAt: new Date().toISOString(),
        size: audioBuffer.byteLength
      }
    });

    // Create Stripe product for this track
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const product = await createStripeProduct(prompt, env, stripe);

    return new Response(JSON.stringify({
      success: true,
      id: trackId,
      prompt: prompt,
      duration: duration,
      model: model,
      audioUrl: `https://music-ai.YOUR_ACCOUNT.workers.dev/track/${trackId}`,
      productId: product.id,
      priceId: product.default_price,
      createdAt: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Music generation error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      prompt: prompt,
      model: model
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function listTracks(env) {
  try {
    const list = await env.MUSIC_AI.list();
    const tracks = list.keys.map(key => ({
      id: key.name,
      ...key.metadata,
      url: `https://music-ai.YOUR_ACCOUNT.workers.dev/track/${key.name}`
    }));

    return new Response(JSON.stringify({
      success: true,
      tracks: tracks,
      count: tracks.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error listing tracks:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function getTrack(url, env) {
  const trackId = url.pathname.split('/').pop();
  
  try {
    const track = await env.MUSIC_AI.get(trackId, { type: 'arrayBuffer' });
    
    if (!track) {
      return new Response(JSON.stringify({ error: 'Track not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(track, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': `attachment; filename="${trackId}.mp3"`,
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error) {
    console.error('Error retrieving track:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function createStripeProduct(prompt, env, stripe) {
  try {
    // Create a product for the AI-generated music
    const product = await stripe.products.create({
      name: `AI Music: ${prompt.substring(0, 50)}`,
      description: `AI-generated music based on: ${prompt.substring(0, 100)}`,
      metadata: {
        prompt: prompt.substring(0, 500),
        type: 'music',
        generated_by: 'music-ai-worker',
        created_at: new Date().toISOString()
      }
    });

    // Create a price for the product
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 999, // $9.99
      currency: 'usd',
      metadata: {
        product_id: product.id,
        type: 'one_time_purchase'
      }
    });

    return { ...product, default_price: price.id };
  } catch (error) {
    console.error('Error creating Stripe product:', error);
    // Return a fallback product ID if creation fails
    return {
      id: 'fallback_product',
      default_price: 'fallback_price',
      name: `AI Music: ${prompt.substring(0, 50)}`,
      description: `AI-generated music (Stripe product creation failed)`
    };
  }
}