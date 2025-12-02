import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

serve(async (req: Request) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  // CRITICAL: Handle WebSocket upgrades FIRST, before health checks
  if (upgradeHeader.toLowerCase() === "websocket") {
    // Extract parameters from URL
    const agentId = url.searchParams.get("agent_id");
    const businessName = url.searchParams.get("business_name") || "there";
    const phoneNumber = url.searchParams.get("phone_number") || "";
    const callSid = url.searchParams.get("call_sid") || "";

    console.log(`[${callSid}] WebSocket upgrade request received`);

    if (!agentId) {
      console.error(`[${callSid}] Missing agent_id`);
      return new Response("Missing agent_id", { status: 400 });
    }

    if (!ELEVENLABS_API_KEY) {
      console.error(`[${callSid}] ELEVENLABS_API_KEY not configured`);
      return new Response("Server configuration error", { status: 500 });
    }

    // Upgrade to WebSocket IMMEDIATELY (no async operations before this!)
    const { socket: twilioSocket, response } = Deno.upgradeWebSocket(req);

    let elevenlabsSocket: WebSocket | null = null;
    let streamSid: string | null = null;
    let elevenlabsReady = false;
    const audioBuffer: Uint8Array[] = [];

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
          console.error(`[${callSid}] Failed to get signed URL: ${response.status} - ${errorText}`);
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

          // Send initial configuration
          const initMessage = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: `The caller's business name is ${businessName}. Their phone number is ${phoneNumber}.`
                },
                first_message: `Hi ${businessName}! Thanks for calling. How can I help you today?`,
              }
            }
          };

          elevenlabsSocket!.send(JSON.stringify(initMessage));
          elevenlabsReady = true;
          console.log(`[${callSid}] ElevenLabs ready, sent init message`);

          // Send any buffered audio
          while (audioBuffer.length > 0) {
            const bufferedAudio = audioBuffer.shift();
            if (bufferedAudio) {
              elevenlabsSocket!.send(bufferedAudio);
            }
          }
        };

        elevenlabsSocket.onmessage = (event) => {
          try {
            if (event.data instanceof Blob) {
              // Binary audio data from ElevenLabs
              event.data.arrayBuffer().then((buffer) => {
                const audioData = new Uint8Array(buffer);
                // Convert to base64 for Twilio
                const base64Audio = btoa(String.fromCharCode(...audioData));

                if (twilioSocket.readyState === WebSocket.OPEN && streamSid) {
                  twilioSocket.send(JSON.stringify({
                    event: "media",
                    streamSid: streamSid,
                    media: {
                      payload: base64Audio
                    }
                  }));
                }
              });
            } else {
              // JSON message from ElevenLabs
              const message = JSON.parse(event.data);
              console.log(`[${callSid}] ElevenLabs message:`, message.type);
            }
          } catch (e) {
            console.error(`[${callSid}] Error processing ElevenLabs message:`, e);
          }
        };

        elevenlabsSocket.onerror = (error) => {
          console.error(`[${callSid}] ElevenLabs WebSocket error:`, error);
        };

        elevenlabsSocket.onclose = () => {
          console.log(`[${callSid}] ElevenLabs WebSocket closed`);
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
          // Decode Twilio's base64 mulaw audio
          const audioData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));

          if (elevenlabsReady && elevenlabsSocket?.readyState === WebSocket.OPEN) {
            elevenlabsSocket.send(audioData);
          } else {
            // Buffer audio until ElevenLabs is ready
            audioBuffer.push(audioData);
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

  // Health checks - only reached for non-WebSocket requests
  if (url.pathname === "/health" || url.pathname === "/") {
    return new Response("OK", { status: 200 });
  }

  return new Response("Expected WebSocket", { status: 426 });
});
