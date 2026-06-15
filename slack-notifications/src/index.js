export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        worker: 'slack-notifications',
        timestamp: new Date().toISOString()
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'x-success-keywords': 'healthy,slack,worker,notifications,active'
        }
      });
    }

    // Send notification
    if (path === '/api/notify' && request.method === 'POST') {
      return sendSlackNotification(request, env);
    }

    // Send message to specific channel
    if (path === '/api/message' && request.method === 'POST') {
      return sendSlackMessage(request, env);
    }

    return new Response('Slack Notifications Worker', { status: 200 });
  }
};

async function sendSlackNotification(request, env) {
  try {
    const { message, channel, username, icon_emoji, blocks } = await request.json();
    
    const payload = {
      channel: channel || env.SLACK_CHANNEL,
      text: message,
      username: username || 'KeyforAgents Bot',
      icon_emoji: icon_emoji || ':robot_face:'
    };

    // Add blocks if provided
    if (blocks) {
      payload.blocks = blocks;
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!data.ok) {
      console.error('Slack API error:', data.error);
      return new Response(JSON.stringify({
        success: false,
        error: data.error,
        success_keywords: ['failed', 'slack', 'error']
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'x-success-keywords': 'failed,slack,error'
        }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      channel: data.channel,
      ts: data.ts,
      message: message,
      success_keywords: ['posted', 'slack', 'notification', 'success', 'delivered']
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'x-success-keywords': 'posted,slack,notification,success,delivered'
      }
    });
  } catch (error) {
    console.error('Error sending Slack notification:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      success_keywords: ['failed', 'error', 'exception']
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'x-success-keywords': 'failed,error,exception'
      }
    });
  }
}

async function sendSlackMessage(request, env) {
  try {
    const { channel, text, blocks, attachments } = await request.json();
    
    const payload = {
      channel: channel || env.SLACK_CHANNEL,
      text: text
    };

    if (blocks) payload.blocks = blocks;
    if (attachments) payload.attachments = attachments;

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!data.ok) {
      return new Response(JSON.stringify({
        success: false,
        error: data.error
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      channel: data.channel,
      ts: data.ts,
      success_keywords: ['sent', 'message', 'slack', 'success']
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'x-success-keywords': 'sent,message,slack,success'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}