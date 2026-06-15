import { Stripe } from 'stripe';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/sync/stripe' && request.method === 'POST') {
      return syncStripeToLinear(env);
    }

    if (path === '/sync/github' && request.method === 'POST') {
      return syncGitHubToLinear(env);
    }

    if (path === '/create/issue' && request.method === 'POST') {
      const body = await request.json();
      return createLinearIssue(body, env);
    }

    return new Response('Linear Sync Worker', { status: 200 });
  }
};

async function syncStripeToLinear(env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  // Get recent customers
  const customers = await stripe.customers.list({ limit: 100 });

  for (const customer of customers.data) {
    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        limit: 1
      });

      if (subscriptions.data.length > 0) {
        const subscription = subscriptions.data[0];
        const planName = subscription.items.data[0]?.price?.id || 'Unknown Plan';
        
        await createLinearIssue({
          title: `Customer: ${customer.email} - ${planName}`,
          description: `**Email:** ${customer.email}\n**Plan:** ${planName}\n**Status:** ${subscription.status}\n**Created:** ${new Date(subscription.created * 1000).toISOString()}\n**Customer ID:** ${customer.id}\n**Subscription ID:** ${subscription.id}`,
          team: 'SALES',
          priority: 2,
          labels: ['customer', 'stripe', 'subscription']
        }, env);
      } else {
        // Customer without active subscription
        await createLinearIssue({
          title: `Customer: ${customer.email}`,
          description: `**Email:** ${customer.email}\n**Name:** ${customer.name || 'N/A'}\n**Created:** ${new Date(customer.created * 1000).toISOString()}\n**ID:** ${customer.id}\n**Status:** No active subscription`,
          team: 'SALES',
          priority: 3,
          labels: ['customer', 'stripe', 'no-subscription']
        }, env);
      }
    } catch (error) {
      console.error(`Error syncing customer ${customer.id}:`, error);
      continue;
    }
  }

  return new Response(JSON.stringify({ 
    synced: customers.data.length, 
    message: `Synced ${customers.data.length} customers to Linear` 
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function syncGitHubToLinear(env) {
  // Get open PRs
  const prsResponse = await fetch('https://api.github.com/repos/Niorlusx/Keyforagents-101/pulls?state=open', {
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!prsResponse.ok) {
    return new Response(JSON.stringify({ error: 'Failed to fetch GitHub PRs' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const prs = await prsResponse.json();

  for (const pr of prs) {
    try {
      await createLinearIssue({
        title: `PR: ${pr.title}`,
        description: `**Repository:** Niorlusx/Keyforagents-101\n**PR:** ${pr.html_url}\n**Author:** ${pr.user.login}\n**State:** ${pr.state}\n**Created:** ${pr.created_at}\n**Updated:** ${pr.updated_at}\n\n${pr.body || 'No description provided.'}`,
        team: 'ENG',
        priority: 3,
        labels: ['github', 'pr', 'pull-request']
      }, env);
    } catch (error) {
      console.error(`Error syncing PR ${pr.id}:`, error);
      continue;
    }
  }

  // Get open issues
  const issuesResponse = await fetch('https://api.github.com/repos/Niorlusx/Keyforagents-101/issues?state=open', {
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (issuesResponse.ok) {
    const issues = await issuesResponse.json();
    for (const issue of issues) {
      try {
        await createLinearIssue({
          title: `Issue: ${issue.title}`,
          description: `**Repository:** Niorlusx/Keyforagents-101\n**Issue:** ${issue.html_url}\n**Author:** ${issue.user.login}\n**State:** ${issue.state}\n**Labels:** ${issue.labels.map(l => l.name).join(', ')}\n**Created:** ${issue.created_at}\n\n${issue.body || 'No description provided.'}`,
          team: 'ENG',
          priority: 2,
          labels: ['github', 'issue', 'bug']
        }, env);
      } catch (error) {
        console.error(`Error syncing issue ${issue.id}:`, error);
        continue;
      }
    }
  }

  return new Response(JSON.stringify({ 
    synced: { prs: prs.length, issues: issues?.length || 0 }, 
    message: `Synced ${prs.length} PRs and ${issues?.length || 0} issues to Linear` 
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createLinearIssue(issue, env) {
  try {
    const response = await fetch('https://api.linear.app/graphql', {
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
        variables: {
          input: {
            title: issue.title,
            description: issue.description,
            team: issue.team || 'ENG',
            state: issue.state || 'Todo',
            priority: issue.priority || 3,
            labels: issue.labels || []
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.errors) {
      console.error('Linear GraphQL errors:', result.errors);
      throw new Error(result.errors[0]?.message || 'Unknown GraphQL error');
    }

    return new Response(JSON.stringify(result.data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error creating Linear issue:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}