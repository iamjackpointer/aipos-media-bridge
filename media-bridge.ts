import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

serve(async (req: Request) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  // Handle WebSocket upgrade FIRST (before health check)
  if (upgradeHeader.toLowerCase() === "websocket") {
    // Extract parameters from URL
    const agentId = url.searchParams.get("agent_id");
    const businessName = url.searchParams.get("business_name") || "there";
    const phoneNumber = url.searchParams.get("phone_number") || "";
    const callSid = url.searchParams.get("call_sid") || "";

    if (!agentId) {
      return new Response("Missing agent_id", { status: 400 });
    }

    if (!ELEVENLABS_API_KEY) {
      console.error("ELEVENLABS_API_KEY not configured");
      return new Response("Server configuration error", { status: 500 });
    }

    // Upgrade to WebSocket
    const { socket: twilioSocket, response } = Deno.upgradeWebSocket(req);
    
    let elevenlabsSocket: WebSocket | null = null;
    let streamSid: string | null = null;
    let elevenlabsReady = false;

    twilioSocket.onopen = async () => {
      console.log(`[${callSid}] Twilio WebSocket connected`);
      
      try {
        // Get signed URL from ElevenLabs
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
          {
            method: "GET",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY!,
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[${callSid}] Failed to get signed URL:`, response.status, errorText);
          twilioSocket.close();
          return;
        }

        const data = await response.json();
        const signedUrl = data.signed_url;
        
        console.log(`[${callSid}] Got ElevenLabs signed URL, connecting...`);
        
        // Connect to ElevenLabs
        elevenlabsSocket = new WebSocket(signedUrl);
        
        elevenlabsSocket.onopen = () => {
          console.log(`[${callSid}] ElevenLabs WebSocket connected`);
          
          // Send initial configuration with audio format settings
          const initMessage = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: `The caller's business name is ${businessName}. Their phone number is ${phoneNumber}.`
                },
                first_message: `Hi ${decodeURIComponent(businessName)}! Thanks for calling. How can I help you today?`,
              }
            }
          };
          
          elevenlabsSocket!.send(JSON.stringify(initMessage));
          elevenlabsReady = true;
          console.log(`[${callSid}] Sent init message to ElevenLabs`);
        };

        elevenlabsSocket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
              case "audio":
                // Send audio back to Twilio
                if (streamSid && twilioSocket.readyState === WebSocket.OPEN) {
                  const audioPayload = message.audio?.chunk || message.audio_event?.audio_base_64;
                  if (audioPayload) {
                    twilioSocket.send(JSON.stringify({
                      event: "media",
                      streamSid: streamSid,
                      media: {
                        payload: audioPayload
                      }
                    }));
                  }
                }
                break;
                
              case "interruption":
                // Clear Twilio's audio buffer when user interrupts
                if (streamSid && twilioSocket.readyState === WebSocket.OPEN) {
                  twilioSocket.send(JSON.stringify({
                    event: "clear",
                    streamSid: streamSid
                  }));
                }
                break;
                
              case "ping":
                // Respond to ping with pong
                if (message.ping_event?.event_id) {
                  elevenlabsSocket!.send(JSON.stringify({
                    type: "pong",
                    event_id: message.ping_event.event_id
                  }));
                }
                break;
                
              case "conversation_initiation_metadata":
                console.log(`[${callSid}] Conversation initialized:`, message.conversation_initiation_metadata_event?.conversation_id);
                break;
                
              default:
                console.log(`[${callSid}] ElevenLabs message:`, message.type);
            }
          } catch (e) {
            console.error(`[${callSid}] Error processing ElevenLabs message:`, e);
          }
        };

        elevenlabsSocket.onerror = (error) => {
          console.error(`[${callSid}] ElevenLabs WebSocket error:`, error);
        };

        elevenlabsSocket.onclose = (event) => {
          console.log(`[${callSid}] ElevenLabs WebSocket closed:`, event.code, event.reason);
          if (twilioSocket.readyState === WebSocket.OPEN) {
            twilioSocket.close();
          }
        };

      } catch (error) {
        console.error(`[${callSid}] Error connecting to ElevenLabs:`, error);
        twilioSocket.close();
      }
    };

    twilioSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.event === "start") {
          streamSid = message.start.streamSid;
          console.log(`[${callSid}] Twilio stream started: ${streamSid}`);
        } else if (message.event === "media") {
          // Send audio to ElevenLabs as JSON (not raw binary!)
          if (elevenlabsReady && elevenlabsSocket?.readyState === WebSocket.OPEN) {
            elevenlabsSocket.send(JSON.stringify({
              user_audio_chunk: message.media.payload  // Keep as base64 string
            }));
          }
        } else if (message.event === "stop") {
          console.log(`[${callSid}] Twilio stream stopped`);
          if (elevenlabsSocket?.readyState === WebSocket.OPEN) {
            elevenlabsSocket.close();
          }
        }
      } catch (e) {
        console.error(`[${callSid}] Error processing Twilio message:`, e);
      }
    };

    twilioSocket.onerror = (error) => {
      console.error(`[${callSid}] Twilio WebSocket error:`, error);
    };

    twilioSocket.onclose = () => {
      console.log(`[${callSid}] Twilio WebSocket closed`);
      if (elevenlabsSocket?.readyState === WebSocket.OPEN) {
        elevenlabsSocket.close();
      }
    };

    return response;
  }

  // Health check for non-WebSocket requests
  if (url.pathname === "/health" || url.pathname === "/") {
    return new Response("OK", { status: 200 });
  }

  return new Response("Expected WebSocket", { status: 426 });
});
