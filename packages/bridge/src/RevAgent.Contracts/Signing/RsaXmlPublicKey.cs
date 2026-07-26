using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace RevAgent.Contracts.Signing;

public static class RsaXmlPublicKey
{
    public const int MaxPublicKeyXmlBytes = 64 * 1024;

    public static RSAParameters Parse(string publicKeyXml)
    {
        if (string.IsNullOrWhiteSpace(publicKeyXml))
        {
            throw new InvalidDataException("PublicKeyXml cannot be empty.");
        }

        var byteCount = Encoding.UTF8.GetByteCount(publicKeyXml);
        if (byteCount > MaxPublicKeyXmlBytes)
        {
            throw new InvalidDataException("PublicKeyXml exceeds the 64 KiB limit.");
        }

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersFromEntities = 0,
            MaxCharactersInDocument = MaxPublicKeyXmlBytes,
            IgnoreComments = false,
            IgnoreProcessingInstructions = false,
        };

        XDocument document;
        using (var textReader = new StringReader(publicKeyXml))
        using (var xmlReader = XmlReader.Create(textReader, settings))
        {
            document = XDocument.Load(xmlReader, LoadOptions.PreserveWhitespace);
        }

        if (document.Declaration is not null)
        {
            throw new InvalidDataException(
                "RSA public key XML must not contain an XML declaration.");
        }

        var root = document.Root
            ?? throw new InvalidDataException("RSA public key XML has no root element.");
        RequireOnlyFormattingWhitespace(
            document.Nodes().Where(node => !ReferenceEquals(node, root)),
            "RSA public key XML document");
        RequireExactElement(root, "RSAKeyValue");
        if (root.Attributes().Any())
        {
            throw new InvalidDataException("RSAKeyValue must not contain attributes.");
        }

        RequireOnlyElementsAndFormattingWhitespace(root.Nodes(), "RSAKeyValue");
        var elements = root.Elements().ToArray();
        if (elements.Length != 2)
        {
            throw new InvalidDataException(
                "RSAKeyValue must contain exactly Modulus and Exponent.");
        }

        var modulusElements = elements.Where(
            element => element.Name.NamespaceName.Length == 0
                && element.Name.LocalName == "Modulus").ToArray();
        var exponentElements = elements.Where(
            element => element.Name.NamespaceName.Length == 0
                && element.Name.LocalName == "Exponent").ToArray();
        if (modulusElements.Length != 1 || exponentElements.Length != 1)
        {
            throw new InvalidDataException(
                "RSAKeyValue must contain exactly Modulus and Exponent.");
        }

        var modulusElement = modulusElements[0];
        var exponentElement = exponentElements[0];
        RequireLeaf(modulusElement, "Modulus");
        RequireLeaf(exponentElement, "Exponent");

        byte[] modulus;
        byte[] exponent;
        try
        {
            modulus = Convert.FromBase64String(modulusElement.Value);
            exponent = Convert.FromBase64String(exponentElement.Value);
        }
        catch (FormatException exception)
        {
            throw new InvalidDataException(
                "RSA public key XML contains invalid base64.",
                exception);
        }

        if (modulus.Length == 0 || exponent.Length == 0)
        {
            throw new InvalidDataException(
                "RSA public key Modulus and Exponent must not be empty.");
        }

        return new RSAParameters
        {
            Modulus = modulus,
            Exponent = exponent,
        };
    }

    public static string ComputeFingerprint(string publicKeyXml)
    {
        if (string.IsNullOrWhiteSpace(publicKeyXml))
        {
            throw new InvalidDataException("PublicKeyXml cannot be empty.");
        }

        var normalized = Regex.Replace(publicKeyXml.Trim(), "\\s+", string.Empty);
        return CanonicalJson.Sha256Hex(Encoding.UTF8.GetBytes(normalized));
    }

    private static void RequireExactElement(XElement element, string name)
    {
        if (element.Name.NamespaceName.Length != 0 || element.Name.LocalName != name)
        {
            throw new InvalidDataException($"Expected RSA XML element '{name}'.");
        }
    }

    private static void RequireLeaf(XElement element, string name)
    {
        RequireExactElement(element, name);
        if (element.Attributes().Any()
            || element.Nodes().Any(node => node.GetType() != typeof(XText)))
        {
            throw new InvalidDataException(
                $"RSA XML element '{name}' must be an attribute-free text leaf.");
        }
    }

    private static void RequireOnlyFormattingWhitespace(
        IEnumerable<XNode> nodes,
        string context)
    {
        foreach (var node in nodes)
        {
            if (node.GetType() != typeof(XText)
                || !string.IsNullOrWhiteSpace(((XText)node).Value))
            {
                throw new InvalidDataException(
                    $"{context} contains an unexpected XML node.");
            }
        }
    }

    private static void RequireOnlyElementsAndFormattingWhitespace(
        IEnumerable<XNode> nodes,
        string context)
    {
        foreach (var node in nodes)
        {
            if (node is XElement)
            {
                continue;
            }

            if (node.GetType() == typeof(XText)
                && string.IsNullOrWhiteSpace(((XText)node).Value))
            {
                continue;
            }

            throw new InvalidDataException(
                $"{context} contains an unexpected XML node.");
        }
    }
}
