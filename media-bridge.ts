import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

serve(async (req: Request) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  // Handle WebSocket upgrade FIRST
  if (upgradeHeader.toLowerCase() === "websocket") {
    const agentId = url.searchParams.get("agent_id");
    const businessName = decodeURIComponent(url.searchParams.get("business_name") || "there");
    const phoneNumber = url.searchParams.get("phone_number") || "";
    const callSid = url.searchParams.get("call_sid") || "";

    console.log(`[${callSid}] WebSocket upgrade requested for agent ${agentId}`);

    if (!agentId) {
      return new Response("Missing agent_id", { status: 400 });
    }

    if (!ELEVENLABS_API_KEY) {
      console.error("ELEVENLABS_API_KEY not configured");
      return new Response("Server configuration error", { status: 500 });
    }

    // Upgrade to WebSocket IMMEDIATELY
    const { socket: twilioSocket, response } = Deno.upgradeWebSocket(req);
    
    let elevenlabsSocket: WebSocket | null = null;
    let streamSid: string | null = null;
    let elevenlabsReady = false;
    const audioBuffer: string[] = [];

    twilioSocket.onopen = async () => {
      console.log(`[${callSid}] Twilio WebSocket connected`);
      
      try {
        // Get signed URL from ElevenLabs
        console.log(`[${callSid}] Fetching ElevenLabs signed URL...`);
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
          {
            method: "GET",
            headers: { "xi-api-key": ELEVENLABS_API_KEY! },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[${callSid}] Failed to get signed URL: ${response.status} - ${errorText}`);
          twilioSocket.close();
          return;
        }

        const data = await response.json();
        console.log(`[${callSid}] Got signed URL, connecting to ElevenLabs...`);
        
        elevenlabsSocket = new WebSocket(data.signed_url);
        
        elevenlabsSocket.onopen = () => {
          console.log(`[${callSid}] ElevenLabs WebSocket connected`);
          elevenlabsReady = true;
          
          // Send session configuration
          const sessionConfig = {
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              agent: {
                first_message: `Hi ${businessName}! I'm James from AI POS UK. How can I help you today?`,
                prompt: {
                  prompt: `You are James, a friendly sales agent for AI POS UK. The caller's business is ${businessName} and their phone is ${phoneNumber}. Be conversational and helpful.`
                }
              }
            },
            custom_llm_extra_body: {
              business_name: businessName,
              phone_number: phoneNumber
            }
          };
          
          elevenlabsSocket!.send(JSON.stringify(sessionConfig));
          console.log(`[${callSid}] Sent session config, flushing ${audioBuffer.length} buffered chunks`);
          
          // Flush buffered audio as binary
          audioBuffer.forEach(base64Audio => {
            const mulawData = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
            elevenlabsSocket!.send(mulawData.buffer);
          });
          audioBuffer.length = 0;
        };

        elevenlabsSocket.onmessage = async (event) => {
          try {
            if (typeof event.data === 'string') {
              const msg = JSON.parse(event.data);
              console.log(`[${callSid}] ElevenLabs message: ${msg.type}`);
            } else if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
              // Binary audio from ElevenLabs - send to Twilio
              let audioData: Uint8Array;
              if (event.data instanceof Blob) {
                audioData = new Uint8Array(await event.data.arrayBuffer());
              } else {
                audioData = new Uint8Array(event.data);
              }
              
              const base64Audio = btoa(String.fromCharCode(...audioData));
              
              if (twilioSocket.readyState === WebSocket.OPEN && streamSid) {
                twilioSocket.send(JSON.stringify({
                  event: 'media',
                  streamSid: streamSid,
                  media: { payload: base64Audio }
                }));
              }
            }
          } catch (e) {
            console.error(`[${callSid}] Error processing ElevenLabs message:`, e);
          }
        };

        elevenlabsSocket.onerror = (error) => {
          console.error(`[${callSid}] ElevenLabs error:`, error);
          twilioSocket.close();
        };

        elevenlabsSocket.onclose = () => {
          console.log(`[${callSid}] ElevenLabs closed`);
          if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
        };

      } catch (error) {
        console.error(`[${callSid}] Error:`, error);
        twilioSocket.close();
      }
    };

    twilioSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.event === "start") {
          streamSid = message.start.streamSid;
          console.log(`[${callSid}] Stream started: ${streamSid}`);
        } else if (message.event === "media" && message.media?.payload) {
          // Send audio to ElevenLabs as binary ArrayBuffer
          const mulawData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
          
          if (elevenlabsReady && elevenlabsSocket?.readyState === WebSocket.OPEN) {
            elevenlabsSocket.send(mulawData.buffer);
          } else {
            audioBuffer.push(message.media.payload);
          }
        } else if (message.event === "stop") {
          console.log(`[${callSid}] Stream stopped`);
          elevenlabsSocket?.close();
        }
      } catch (e) {
        console.error(`[${callSid}] Error:`, e);
      }
    };

    twilioSocket.onerror = (error) => console.error(`[${callSid}] Twilio error:`, error);
    twilioSocket.onclose = () => {
      console.log(`[${callSid}] Twilio closed`);
      elevenlabsSocket?.close();
    };

    return response;
  }

  // Health check for non-WebSocket requests
  return new Response("OK", { status: 200 });
});
