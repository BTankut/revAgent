using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace RevAgentPlugin.Core
{
    internal static class BridgeResultContract
    {
        public const int ResultContractVersion = 2;

        private static readonly JsonSerializer CamelCaseSerializer =
            JsonSerializer.Create(new JsonSerializerSettings
            {
                ContractResolver = new DefaultContractResolver
                {
                    NamingStrategy = new CamelCaseNamingStrategy
                    {
                        ProcessDictionaryKeys = false,
                        OverrideSpecifiedNames = false
                    }
                }
            });

        public static JToken CreateResultPayload(object value)
        {
            JToken token = ToCamelCaseToken(value);
            if (token.Type == JTokenType.Object)
            {
                JObject obj = (JObject)token;
                obj["resultContractVersion"] = ResultContractVersion;
                return obj;
            }

            return new JObject
            {
                ["resultContractVersion"] = ResultContractVersion,
                ["value"] = token
            };
        }

        public static JToken ToCamelCaseToken(object value)
        {
            if (value == null)
            {
                return JValue.CreateNull();
            }

            try
            {
                JToken token = value as JToken;
                return token != null ? token.DeepClone() : JToken.FromObject(value, CamelCaseSerializer);
            }
            catch (Exception ex)
            {
                return new JObject
                {
                    ["serializationFallback"] = true,
                    ["value"] = Convert.ToString(value),
                    ["error"] = ex.Message
                };
            }
        }
    }
}
