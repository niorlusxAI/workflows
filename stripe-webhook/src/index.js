import { Stripe } from 'stripe';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Stripe webhook
    if (path === '/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    // GitHub webhook
    if (path === '/github/webhook' && request.method === 'POST') {
      return handleGitHubWebhook(request, env);
    }

    // Linear integration
    if (path === '/linear/sync' && request.method === 'POST') {
      return syncWithLinear(request, env);
    }

    // Music AI
    if (path === '/music/ai' && request.method === 'POST') {
      return handleMusicAI(request, env);
    }

    return new Response('Stripe Webhook Worker', { status: 200 });
  }
};

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Store event in KV
  await env.STRIPE_DATA.put(`event:${event.id}`, JSON.stringify(event), {
    expirationTtl: 86400 * 30 // 30 days
  });

  // Handle specific events
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    await createLinearIssue(invoice, env);
    await updateGitHubIssue(invoice, env);
  }

  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    await env.STRIPE_DATA.put(`subscription:${subscription.id}`, JSON.stringify(subscription));
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await handleCheckout(session, env);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleGitHubWebhook(request, env) {
  const payload = await request.json();
  const event = request.headers.get('x-github-event');

  await env.GITHUB_WEBHOOKS.put(`event:${Date.now()}`, JSON.stringify({
    event,
    payload,
    receivedAt: new Date().toISOString()
  }));

  // Auto-create Linear issue for PRs
  if (event === 'pull_request' && payload.action === 'opened') {
    await createLinearIssueForPR(payload.pull_request, env);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function syncWithLinear(request, env) {
  const { resource, action } = await request.json();

  // Sync Stripe customers to Linear
  if (resource === 'stripe_customer') {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const customers = await stripe.customers.list({ limit: 100 });
    for (const customer of customers.data) {
      await createLinearCustomerIssue(customer, env);
    }
  }

  return new Response(JSON.stringify({ synced: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleMusicAI(request, env) {
  const { prompt, model = 'music-gen' } = await request.json();

  // Generate music using AI
  const musicData = await generateMusic(prompt, model, env);

  await env.MUSIC_AI.put(`track:${Date.now()}`, JSON.stringify({
    prompt,
    model,
    data: musicData,
    createdAt: new Date().toISOString()
  }));

  return new Response(JSON.stringify(musicData), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createLinearIssue(invoice, env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const customer = await stripe.customers.retrieve(invoice.customer);

  const issue = {
    title: `New Payment: ${customer.email} - $${(invoice.amount_paid / 100).toFixed(2)}`,
    description: `**Customer:** ${customer.email}\n**Amount:** $${(invoice.amount_paid / 100).toFixed(2)}\n**Invoice:** ${invoice.hosted_invoice_url}\n**Status:** ${invoice.status}`,
    team: 'SALES',
    state: 'Todo',
    priority: 2,
    labels: ['payment', 'stripe']
  };

  await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': env.LINEAR_API_KEY
    },
    body: JSON.stringify({
      query: `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              title
              url
            }
          }
        }
      `,
      variables: { input: issue }
    })
  });
}

async function updateGitHubIssue(invoice, env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const customer = await stripe.customers.retrieve(invoice.customer);

  await fetch('https://api.github.com/repos/Niorlusx/Keyforagents-101/issues', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${env.GITHUB_PAT}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      title: `Payment Received: ${customer.email}`,
      body: `**Customer:** ${customer.email}\n**Amount:** $${(invoice.amount_paid / 100).toFixed(2)}\n**Invoice:** ${invoice.hosted_invoice_url}\n**Status:** ${invoice.status}`,
      labels: ['payment', 'stripe', 'customer']
    })
  });
}

async function createLinearIssueForPR(pullRequest, env) {
  const issue = {
    title: `PR: ${pullRequest.title}`,
    description: `**Repository:** ${pullRequest.base.repo.full_name}\n**PR:** ${pullRequest.html_url}\n**Author:** ${pullRequest.user.login}\n**State:** ${pullRequest.state}\n\n${pullRequest.body || 'No description provided.'}`,
    team: 'ENG',
    state: 'Todo',
    priority: 3,
    labels: ['github', 'pull-request']
  };

  await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': env.LINEAR_API_KEY
    },
    body: JSON.stringify({
      query: `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              title
              url
            }
          }
        }
      `,
      variables: { input: issue }
    })
  });
}

async function createLinearCustomerIssue(customer, env) {
  const issue = {
    title: `Customer: ${customer.email}`,
    description: `**Email:** ${customer.email}\n**Name:** ${customer.name || 'N/A'}\n**Created:** ${new Date(customer.created * 1000).toISOString()}\n**ID:** ${customer.id}`,
    team: 'SALES',
    state: 'Todo',
    priority: 2,
    labels: ['customer', 'stripe']
  };

  await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': env.LINEAR_API_KEY
    },
    body: JSON.stringify({
      query: `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              title
              url
            }
          }
        }
      `,
      variables: { input: issue }
    })
  });
}

async function handleCheckout(session, env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const customer = await stripe.customers.retrieve(session.customer);

  // Create GitHub issue for onboarding
  await fetch('https://api.github.com/repos/Niorlusx/Keyforagents-101/issues', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${env.GITHUB_PAT}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      title: `Onboard: ${customer.email}`,
      body: `New customer signed up via Stripe.\n\n**Email:** ${customer.email}\n**Plan:** ${session.display_items[0]?.plan?.name || 'Unknown'}\n**Amount:** $${session.amount_total / 100}\n**Subscription:** ${session.subscription}`,
      labels: ['onboarding', 'stripe', 'customer']
    })
  });
}

async function generateMusic(prompt, model, env) {
  // Call OpenAI or other AI music service
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: prompt,
        voice: 'alloy'
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const audio = await response.arrayBuffer();
    return {
      success: true,
      audio: Buffer.from(audio).toString('base64'),
      model: model,
      prompt: prompt,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Music generation error:', error);
    return {
      success: false,
      error: error.message,
      prompt: prompt,
      model: model
    };
  }
}